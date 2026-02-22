import fitz  # PyMuPDF
import os, re, json, sys
from typing import List, Dict, Any, Tuple

# ---------- Patterns ----------
CHOICE_RE = re.compile(r"^\s*([a-dA-D])\s*[\.\)]\s*(.*)\s*$")
QSTART_LINE_RE = re.compile(r"^\s*Q\s*(\d{1,3})\s*[\.\)]\s*(.*)$", re.IGNORECASE)

VISUAL_HINT_RE = re.compile(
    r"\b(figure|fig\.|shown below|shown in the figure|diagram|table|graph|chart|illustration)\b",
    re.IGNORECASE
)

def ensure_dir(p: str):
    os.makedirs(p, exist_ok=True)

def normalize_spaces(s: str) -> str:
    s = s.replace("\u00a0", " ")
    s = re.sub(r"[ \t]+", " ", s)
    return s

# ---------- Layout helpers ----------
def group_words_into_lines(words: List[List[Any]]) -> List[Dict[str, Any]]:
    """
    words items: [x0, y0, x1, y1, "word", block_no, line_no, word_no]
    Returns lines with text + bbox.
    """
    lines_map: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for w in words:
        x0, y0, x1, y1, txt, bno, lno, _wno = w
        key = (bno, lno)
        if key not in lines_map:
            lines_map[key] = {"words": [], "bbox": [x0, y0, x1, y1]}
        lines_map[key]["words"].append((x0, txt))
        bb = lines_map[key]["bbox"]
        bb[0] = min(bb[0], x0)
        bb[1] = min(bb[1], y0)
        bb[2] = max(bb[2], x1)
        bb[3] = max(bb[3], y1)

    lines = []
    for (_bno, _lno), v in lines_map.items():
        v["words"].sort(key=lambda t: t[0])
        text = " ".join(t for _, t in v["words"]).strip()
        lines.append({"text": text, "bbox": v["bbox"]})

    # Sort by y then x
    lines.sort(key=lambda d: (d["bbox"][1], d["bbox"][0]))
    return lines

def find_question_starts(lines: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Robust: detects Qn even when prompt continues on the same line:
      "Q74. From the viewpoint..."
    """
    starts = []
    for ln in lines:
        t = re.sub(r"\s+", " ", ln["text"]).strip()
        m = QSTART_LINE_RE.match(t)
        if m:
            starts.append({
                "number": int(m.group(1)),
                "bbox": ln["bbox"],
                "lineText": t
            })

    # Sort by y
    starts.sort(key=lambda s: s["bbox"][1])

    # De-dupe by number (overlay duplicates)
    seen = set()
    deduped = []
    for s in starts:
        if s["number"] in seen:
            continue
        seen.add(s["number"])
        deduped.append(s)

    return deduped

# ---------- Non-text detection for forcing image type ----------
def clip_has_image_block(page: fitz.Page, clip: fitz.Rect) -> bool:
    d = page.get_text("dict", clip=clip)
    for b in d.get("blocks", []):
        if b.get("type") == 1:
            return True
    return False

def clip_has_drawings(page: fitz.Page, clip: fitz.Rect, area_threshold: float = 300.0) -> bool:
    """
    Detect vector drawings (tables/boxes/diagrams). Threshold prevents tiny artifacts.
    """
    try:
        drawings = page.get_drawings()
    except Exception:
        return False

    for dr in drawings:
        r = dr.get("rect")
        if not r:
            continue
        r = fitz.Rect(r)
        inter = r & clip
        if inter.is_empty:
            continue
        if inter.get_area() > area_threshold:
            return True
    return False

def has_visual_hint(prompt: str) -> bool:
    return bool(VISUAL_HINT_RE.search(prompt or ""))

# ---------- MCQ parsing from clipped text ----------
def parse_mcq_text(text: str) -> Tuple[str, List[str], List[str]]:
    issues = []
    text = normalize_spaces(text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    # Remove leading "Qn." prefix; keep rest of line if present
    if lines:
        m = QSTART_LINE_RE.match(lines[0])
        if m:
            rest = (m.group(2) or "").strip()
            lines = lines[1:]
            if rest:
                lines.insert(0, rest)

    prompt_lines = []
    choices_map: Dict[str, str] = {}
    mode = "prompt"
    last_choice = None

    for ln in lines:
        m = CHOICE_RE.match(ln)
        if m:
            key = m.group(1).upper()
            txt = (m.group(2) or "").strip()
            choices_map[key] = txt
            mode = "choices"
            last_choice = key
            continue

        if mode == "choices" and last_choice:
            choices_map[last_choice] = (choices_map[last_choice] + " " + ln).strip()
        else:
            prompt_lines.append(ln)

    prompt = "\n".join(prompt_lines).strip()
    choices = [(choices_map.get(k) or "").strip() for k in ["A", "B", "C", "D"]]

    if not prompt:
        issues.append("missing_prompt")
    if any(c == "" for c in choices):
        issues.append("missing_choice")

    return prompt, choices, issues

def crop_question_image(page: fitz.Page, clip: fitz.Rect, out_path: str, zoom: float = 2.0):
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, clip=clip, alpha=False)
    pix.save(out_path)

# ---------- Answers PDF extraction (table, 2-column OK) ----------
def extract_answers_from_pdf(answers_pdf_path: str) -> Dict[int, str]:
    doc = fitz.open(answers_pdf_path)
    ans_map: Dict[int, str] = {}

    for page in doc:
        words = page.get_text("words") or []
        if not words:
            continue

        items = []
        for x0, y0, x1, y1, txt, *_ in words:
            t = txt.strip()
            if t:
                items.append({"x0": x0, "y0": y0, "text": t})

        items.sort(key=lambda it: (it["y0"], it["x0"]))

        rows: List[List[Dict[str, Any]]] = []
        y_tol = 2.8
        for it in items:
            if not rows:
                rows.append([it])
                continue
            if abs(it["y0"] - rows[-1][0]["y0"]) <= y_tol:
                rows[-1].append(it)
            else:
                rows.append([it])

        for row in rows:
            row.sort(key=lambda it: it["x0"])
            tokens = [r["text"] for r in row]

            filtered = []
            for t in tokens:
                tl = t.lower().strip().replace(":", "")
                if tl in {"q.no", "q.no.", "qno", "q", "no", "correct", "answer"}:
                    continue
                filtered.append(t)

            i = 0
            while i < len(filtered) - 1:
                qtok = filtered[i]
                atok = filtered[i + 1]
                qdigits = re.sub(r"[^0-9]", "", qtok)
                if qdigits.isdigit() and re.fullmatch(r"[a-dA-D]", atok.strip()):
                    ans_map[int(qdigits)] = atok.strip().upper()
                    i += 2
                else:
                    i += 1

    return ans_map

# ---------- Main build ----------
def build_questions_with_answers(
    questions_pdf_path: str,
    answers_pdf_path: str,
    exam_year: int,
    exam_month: int,
    out_dir: str
):
    ensure_dir(out_dir)
    img_dir = os.path.join(out_dir, "question_images")
    ensure_dir(img_dir)

    answers_map = extract_answers_from_pdf(answers_pdf_path)
    qdoc = fitz.open(questions_pdf_path)

    all_questions: List[Dict[str, Any]] = []
    report_issues: List[Dict[str, Any]] = []

    for page_index in range(len(qdoc)):
        page = qdoc[page_index]
        page_no = page_index + 1

        words = page.get_text("words") or []
        if not words:
            continue

        lines = group_words_into_lines(words)
        qstarts = find_question_starts(lines)
        if not qstarts:
            continue

        page_rect = page.rect

        for i, qs in enumerate(qstarts):
            qnum = qs["number"]
            start_y = qs["bbox"][1]

            # End is next question start (same page), else end of page
            end_y = qstarts[i + 1]["bbox"][1] - 2 if i + 1 < len(qstarts) else page_rect.y1

            start_y = max(page_rect.y0, start_y - 2)
            end_y = min(page_rect.y1, end_y)

            # ✅ single-column questions PDF: always full width
            clip = fitz.Rect(page_rect.x0, start_y, page_rect.x1, end_y)

            img_name = f"p{page_no:03d}_q{qnum:03d}.png"
            img_path = os.path.join(img_dir, img_name)
            crop_question_image(page, clip, img_path, zoom=2.0)

            clipped_text = page.get_text("text", clip=clip) or ""
            prompt, choices, issues = parse_mcq_text(clipped_text)

            # Force image if non-text content exists (diagram/table), or visual hints
            nontext = (
                clip_has_image_block(page, clip) or
                clip_has_drawings(page, clip, area_threshold=300.0) or
                has_visual_hint(prompt)
            )

            qtype = "image" if nontext else ("pure_text" if len(issues) == 0 else "image")

            answer_key = answers_map.get(qnum, "")

            qobj = {
                "number": qnum,
                "type": qtype,
                "prompt": prompt if qtype == "pure_text" else (prompt or "Refer to the image."),
                "choices": choices if qtype == "pure_text" else (choices if any(c for c in choices) else ["A", "B", "C", "D"]),
                "answerKey": answer_key,
                "mediaFiles": [os.path.join("question_images", img_name)] if qtype == "image" else []
            }

            if issues or not answer_key:
                report_issues.append({
                    "page": page_no,
                    "number": qnum,
                    "issues": issues,
                    "missingAnswerKey": (answer_key == ""),
                    "image": qobj["mediaFiles"][0] if qobj["mediaFiles"] else None
                })

            all_questions.append(qobj)

    # De-dupe and sort
    by_num = {q["number"]: q for q in all_questions}
    all_questions = sorted(by_num.values(), key=lambda q: q["number"])

    nums = sorted(q["number"] for q in all_questions)
    missing = [n for n in range(1, 101) if n not in set(nums)]

    out = {
        "exam": {"year": exam_year, "month": exam_month},
        "questions": all_questions,
        "report": {
            "questionCount": len(all_questions),
            "imageTypeCount": sum(1 for q in all_questions if q["type"] == "image"),
            "missingAnswerKeyCount": sum(1 for q in all_questions if not q["answerKey"]),
            "missingNumbers": missing,
            "issues": report_issues
        }
    }

    out_json = os.path.join(out_dir, f"exam_{exam_year}_{exam_month:02d}.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print("✅ Done")
    print(f"   Questions: {out['report']['questionCount']}")
    print(f"   Image-type: {out['report']['imageTypeCount']}")
    print(f"   Missing answerKey: {out['report']['missingAnswerKeyCount']}")
    print(f"   Missing question numbers: {len(missing)}")
    if missing:
        print(f"   Missing sample: {missing[:25]}")
    print(f"   Output JSON: {out_json}")
    print(f"   Images folder: {img_dir}")

if __name__ == "__main__":
    if len(sys.argv) < 6:
        print("Usage: python parse_and_crop_with_answers.py <questions_pdf> <answers_pdf> <year> <month> <out_dir>")
        sys.exit(1)

    questions_pdf = sys.argv[1]
    answers_pdf = sys.argv[2]
    year = int(sys.argv[3])
    month = int(sys.argv[4])
    out_dir = sys.argv[5]

    build_questions_with_answers(questions_pdf, answers_pdf, year, month, out_dir)