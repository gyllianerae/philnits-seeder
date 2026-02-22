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

function toExamFolder(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`
}

function normalizeRelPath(p) {
  // Make both "\" and "/" work across OS
  return p.replace(/[\\/]+/g, path.sep)
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
  return data.path // object path in bucket
}

async function uploadAllQuestionImages(jsonDir, examFolder) {
  const imagesDir = path.join(jsonDir, 'question_images')
  if (!fs.existsSync(imagesDir)) {
    console.log('⚠️ No question_images folder found:', imagesDir)
    return new Map()
  }

  const files = fs.readdirSync(imagesDir).filter(f => /\.(png|jpe?g)$/i.test(f))
  console.log(`🖼️ Found ${files.length} images in question_images/`)

  // Map: filename -> uploaded storage path
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
  // Prefer the filename in JSON mediaFiles if present (e.g. question_images\p011_q020.png)
  const mf = (q.mediaFiles || [])[0]
  if (mf) return path.basename(mf.replace(/\\/g, '/'))

  // Fallback (works if your crops are always p###_q###.png but you don't know page):
  // We can’t derive page from number alone, so we cannot guarantee the exact filename.
  // In practice your JSON already includes it for image-type questions.
  return null
}

async function main() {
  const jsonPath = process.argv[2]
  if (!jsonPath) {
    console.error('Usage: node seed.js <path_to_exam_json>')
    process.exit(1)
  }

  const absJsonPath = path.resolve(jsonPath)
  const jsonDir = path.dirname(absJsonPath)
  const payload = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'))

  const year = payload.exam.year
  const month = payload.exam.month
  const examFolder = toExamFolder(year, month)

  // 0) Upload ALL images first
  const uploadedMap = await uploadAllQuestionImages(jsonDir, examFolder)

  // 1) Upsert exam (unique on year+month)
  const { data: examRows, error: examErr } = await supabase
    .from('exams')
    .upsert({ year, month }, { onConflict: 'year,month' })
    .select('id')
    .single()

  if (examErr) throw examErr
  const examId = examRows.id
  console.log('✅ Exam upserted:', examId)

  // 2) Build question rows (now: EVERY question gets media_paths if crop exists)
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

    // Use the crop filename referenced in JSON if available
    const cropFilename = findLocalCropFilenameForQuestion(q)

    if (cropFilename && uploadedMap.has(cropFilename)) {
      media_paths = [uploadedMap.get(cropFilename)]
      withMedia++
    } else {
      // If JSON didn't have mediaFiles (pure_text questions), we try to find a crop by scanning:
      // Strategy: find any uploaded filename ending with `_qNNN.png` (or jpg)
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

  // 3) Upsert questions
  const { error: qErr } = await supabase
    .from('questions')
    .upsert(questionRows, { onConflict: 'exam_id,number' })

  if (qErr) throw qErr

  console.log(`🎉 Seeded ${questionRows.length} questions for ${examFolder}`)
  console.log(`🧷 Questions with media_paths: ${withMedia}`)
  console.log(`⚠️ Questions missing media_paths: ${missingMedia}`)
  console.log(`📦 Bucket: ${BUCKET}`)
}

main().catch((e) => {
  console.error('❌ Seed failed:', e)
  process.exit(1)
})