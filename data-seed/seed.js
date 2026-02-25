import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({
  path: path.resolve(__dirname, '../.env')
})

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = process.env.SUPABASE_BUCKET || 'question-assets'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

function normalizeExamSet(s) {
  const v = String(s || '').trim().toUpperCase()
  if (v !== 'A' && v !== 'B') {
    throw new Error(`Invalid exam_set "${s}". Use "A" or "B".`)
  }
  return v
}

function toExamFolder(year, month, examSet) {
  // Put examSet in folder so A/B don’t overwrite each other
  return `${year}-${String(month).padStart(2, '0')}-${examSet}`
}

function guessContentType(filename) {
  const f = filename.toLowerCase()
  if (f.endsWith('.png')) return 'image/png'
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

async function uploadFile(localPath, destPath) {
  const buf = fs.readFileSync(localPath)
  const contentType = guessContentType(destPath)

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(destPath, buf, { upsert: true, contentType })

  if (error) throw new Error(`Upload failed for ${destPath}: ${error.message}`)
  return data.path
}

async function uploadAllQuestionImages(jsonDir, examFolder) {
  const imagesDir = path.join(jsonDir, 'question_images')
  if (!fs.existsSync(imagesDir)) {
    console.log('⚠️ No question_images folder found:', imagesDir)
    return new Map()
  }

  const files = fs.readdirSync(imagesDir).filter(f => /\.(png|jpe?g)$/i.test(f))
  console.log(`🖼️ Found ${files.length} images in question_images/`)

  const uploaded = new Map()

  for (const f of files) {
    const localPath = path.join(imagesDir, f)
    const destPath = `${examFolder}/${f}`

    const storagePath = await uploadFile(localPath, destPath)
    uploaded.set(f, storagePath)
  }

  console.log(`✅ Uploaded (or upserted) ${files.length} images to ${BUCKET}/${examFolder}/`)
  return uploaded
}

function findLocalCropFilenameForQuestion(q) {
  const mf = (q.mediaFiles || [])[0]
  if (mf) return path.basename(mf.replace(/\\/g, '/'))
  return null
}

function inferExamSetFromJsonPath(jsonPath, fallback = 'A') {
  const base = path.basename(jsonPath, path.extname(jsonPath)).toUpperCase()
  // Expect filenames like FE-A_2024_04 or FE-B_2024_04
  const m = base.match(/^FE-([AB])[_-]/)
  if (m && m[1]) {
    return normalizeExamSet(m[1])
  }
  return normalizeExamSet(fallback)
}

async function main() {
  const jsonPath = process.argv[2]
  if (!jsonPath) {
    console.error('Usage: node seed.js <path_to_exam_json> [A|B]')
    process.exit(1)
  }

  const examSetArg = process.argv[3]
  const exam_set = examSetArg
    ? normalizeExamSet(examSetArg)
    : inferExamSetFromJsonPath(jsonPath, 'A')

  const absJsonPath = path.resolve(jsonPath)
  const jsonDir = path.dirname(absJsonPath)
  const payload = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'))

  const year = payload.exam.year
  const month = payload.exam.month
  const examFolder = toExamFolder(year, month, exam_set)

  // 0) Upload ALL images first
  const uploadedMap = await uploadAllQuestionImages(jsonDir, examFolder)

  // 1) Upsert exam (unique on year+month+exam_set)
  const { data: examRows, error: examErr } = await supabase
    .from('exams')
    .upsert({ year, month, exam_set }, { onConflict: 'year,month,exam_set' })
    .select('id')
    .single()

  if (examErr) throw examErr
  const examId = examRows.id
  console.log('✅ Exam upserted:', examId, `(${year}-${month} set ${exam_set})`)

  // 2) Build question rows (EVERY question gets media_paths if crop exists)
  const questionRows = []
  let withMedia = 0
  let missingMedia = 0

  for (const q of payload.questions) {
    const number = Number(q.number)
    const type = q.type || 'pure_text'
    const prompt = q.prompt || ''
    const choices = q.choices || []
    const answer_key = (q.answerKey || '').toUpperCase()

    let media_paths = []

    const cropFilename = findLocalCropFilenameForQuestion(q)

    if (cropFilename && uploadedMap.has(cropFilename)) {
      media_paths = [uploadedMap.get(cropFilename)]
      withMedia++
    } else {
      const suffix = `_q${String(number).padStart(3, '0')}.`
      let match = null
      for (const [fname, spath] of uploadedMap.entries()) {
        if (fname.toLowerCase().includes(suffix)) {
          match = spath
          break
        }
      }
      if (match) {
        media_paths = [match]
        withMedia++
      } else {
        missingMedia++
      }
    }

    questionRows.push({
      exam_id: examId,
      number,
      type,
      prompt,
      choices,
      answer_key,
      media_paths,
    })
  }

  // 3) Upsert questions (unique on exam_id+number)
  const { error: qErr } = await supabase
    .from('questions')
    .upsert(questionRows, { onConflict: 'exam_id,number' })

  if (qErr) throw qErr

  console.log(`🎉 Seeded ${questionRows.length} questions for ${year}-${String(month).padStart(2,'0')} set ${exam_set}`)
  console.log(`🧷 Questions with media_paths: ${withMedia}`)
  console.log(`⚠️ Questions missing media_paths: ${missingMedia}`)
  console.log(`📦 Bucket: ${BUCKET}`)
}

main().catch((e) => {
  console.error('❌ Seed failed:', e)
  process.exit(1)
})