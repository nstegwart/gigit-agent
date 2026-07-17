/**
 * Work ownerDisplay title policy (ADDENDUM V1.1 §C / W-FIX-WORK).
 * Placeholder must never be the sole primary title; taskId is last-resort fallback.
 */
import { describe, expect, it } from 'vitest'
import {
  cleanTechnicalTitle,
  isOwnerTitlePlaceholder,
  OWNER_CONTENT_PLACEHOLDER,
  resolveOwnerDisplay,
} from '#/components/control-center/work/ownerDisplay'

describe('isOwnerTitlePlaceholder', () => {
  it('detects empty and known shell strings', () => {
    expect(isOwnerTitlePlaceholder(null)).toBe(true)
    expect(isOwnerTitlePlaceholder('')).toBe(true)
    expect(isOwnerTitlePlaceholder(OWNER_CONTENT_PLACEHOLDER)).toBe(true)
    expect(isOwnerTitlePlaceholder('Konten perlu ditinjau')).toBe(true)
    expect(isOwnerTitlePlaceholder('CONTENT_REVIEW_REQUIRED')).toBe(true)
    expect(isOwnerTitlePlaceholder('Meditasi RN')).toBe(false)
  })
})

describe('cleanTechnicalTitle', () => {
  it('strips [FC-*] and T-* tokens for scanability', () => {
    expect(cleanTechnicalTitle('[FC-99] raw technical must not be primary')).toBe(
      'Raw technical must not be primary',
    )
    expect(cleanTechnicalTitle('T-RN-WELL-MED meditation map')).toMatch(
      /meditation map/i,
    )
  })
})

describe('resolveOwnerDisplay V1.1 §C', () => {
  it('reviewed human title wins; technical stays secondary metadata', () => {
    const r = resolveOwnerDisplay({
      technicalTitle: '[FC-1] tech',
      taskId: 'T-1',
      ownerPrimaryTitle: 'Selesaikan list work',
      contentReviewRequired: false,
      effectiveReviewStatus: 'REVIEWED',
    })
    expect(r.primaryTitle).toBe('Selesaikan list work')
    expect(r.contentReviewRequired).toBe(false)
    expect(r.usedTechnicalFallback).toBe(false)
  })

  it('missing projection → cleaned technical primary + review required', () => {
    const r = resolveOwnerDisplay({
      technicalTitle: '[FC-99] raw technical must not be primary',
      taskId: 't-hd-shell',
    })
    expect(r.primaryTitle).not.toBe(OWNER_CONTENT_PLACEHOLDER)
    expect(r.primaryTitle).not.toBe('Konten perlu ditinjau')
    expect(r.primaryTitle.toLowerCase()).toMatch(/raw technical/)
    expect(r.contentReviewRequired).toBe(true)
    expect(r.usedTechnicalFallback).toBe(true)
  })

  it('placeholder ownerPrimary falls back to cleaned technical, never stays placeholder', () => {
    const r = resolveOwnerDisplay({
      technicalTitle: 'Admin Ads (myfitsociety-backend)',
      taskId: 'T-PLATFORM-admin-ads',
      ownerPrimaryTitle: OWNER_CONTENT_PLACEHOLDER,
      contentReviewRequired: true,
      effectiveReviewStatus: 'CONTENT_REVIEW_REQUIRED',
    })
    expect(r.primaryTitle).toBe('Admin Ads (myfitsociety-backend)')
    expect(r.primaryTitle).not.toBe(OWNER_CONTENT_PLACEHOLDER)
    expect(r.contentReviewRequired).toBe(true)
  })

  it('no title at all → taskId as last-resort primary', () => {
    const r = resolveOwnerDisplay({
      technicalTitle: '',
      taskId: 'T-ONLY-ID',
      ownerPrimaryTitle: OWNER_CONTENT_PLACEHOLDER,
      contentReviewRequired: true,
    })
    expect(r.primaryTitle).toBe('T-ONLY-ID')
    expect(r.contentReviewRequired).toBe(true)
  })

  it('GENERATED_NEEDS_REVIEW keeps generated human title but not ready', () => {
    const r = resolveOwnerDisplay({
      technicalTitle: '[TECH] x',
      taskId: 'T-G',
      ownerPrimaryTitle: 'Modul backend: kontroler Meditasi',
      contentReviewRequired: false,
      effectiveReviewStatus: 'GENERATED_NEEDS_REVIEW',
    })
    expect(r.primaryTitle).toBe('Modul backend: kontroler Meditasi')
    expect(r.contentReviewRequired).toBe(true)
  })
})
