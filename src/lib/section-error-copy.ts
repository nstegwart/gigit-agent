/**
 * Plain-language (id-ID) sentences for server `sectionErrors` codes.
 * Section errors are internal control-plane diagnostics; they must never render
 * as raw `CODE: message` strings in primary owner-facing copy (ART-UX-DIRECTION
 * "NO RAW DATA AS PRIMARY UX"). The raw code/message stays available as secondary
 * technical detail — this only supplies the primary human sentence.
 */

const SECTION_ERROR_SENTENCES: Record<string, string> = {
  DATA_INTEGRITY:
    'Data belum bisa dipercaya sepenuhnya karena ada tugas tanpa bukti klasifikasi yang valid — sistem menahan status ini sampai data diperbaiki.',
  ACCOUNT_SYNC_MISSING:
    'Belum ada data sinkronisasi akun agen yang sah, jadi kapasitas kerja ditampilkan sebagai kosong sampai sinkronisasi tersedia.',
  ACCOUNT_SYNC_STALE:
    'Data sinkronisasi akun agen sudah basi — angka kapasitas mungkin tidak mencerminkan kondisi terkini.',
  PIN_AUTHORITY_FALLBACK:
    'Penanda revisi board belum lengkap; sistem memakai nilai cadangan sementara sambil menahan pengikatan resmi.',
  PIN_AUTHORITY_INCOMPLETE:
    'Otorisasi revisi board belum lengkap, sehingga sejumlah panel menahan diri (fail-closed) sampai penanda resmi tersedia.',
  DEFINITION_AUTHORITY_STALE:
    'Definisi tugas/fitur ini sudah tidak sinkron dengan revisi board terkini dan perlu disamakan ulang sebelum dipercaya.',
  REVISION_AUTHORITY_MISSING:
    'Sumber revisi resmi belum ditemukan, sehingga bagian ini tidak dapat memastikan datanya adalah versi terbaru.',
  PARTIAL_SOURCE:
    'Sebagian sumber data tidak dapat dibaca — bagian ini menampilkan data yang tersedia saja, bukan gambaran lengkap.',
}

const FALLBACK_SENTENCE =
  'Ada masalah integritas data pada bagian ini yang belum bisa dijelaskan secara otomatis — lihat detail teknis.'

/** Human-readable primary sentence for a section-error code. Never returns the raw code. */
export function sectionErrorHumanSentence(code: string): string {
  return SECTION_ERROR_SENTENCES[code] ?? FALLBACK_SENTENCE
}
