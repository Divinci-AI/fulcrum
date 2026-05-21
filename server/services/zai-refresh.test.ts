import { describe, expect, test } from 'bun:test'
import { selectModels } from './zai-refresh'

describe('zai-refresh.selectModels', () => {
  test('picks newest flagship and turbo from the current full list (2026-05)', () => {
    const ids = [
      'glm-4-32b-0414-128k',
      'glm-4.5',
      'glm-4.5-air',
      'glm-4.5-airx',
      'glm-4.5-flash',
      'glm-4.5-x',
      'glm-4.6',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.7-flashx',
      'glm-5',
      'glm-5-turbo',
      'glm-5.1',
    ]
    expect(selectModels(ids)).toEqual({
      haikuModel: 'glm-5-turbo',
      sonnetModel: 'glm-5.1',
      opusModel: 'glm-5.1',
    })
  })

  test('prefers higher version for both flagship and turbo', () => {
    const ids = ['glm-4.5', 'glm-4.5-turbo', 'glm-5', 'glm-5-turbo', 'glm-6', 'glm-6-turbo']
    expect(selectModels(ids)).toEqual({
      haikuModel: 'glm-6-turbo',
      sonnetModel: 'glm-6',
      opusModel: 'glm-6',
    })
  })

  test('falls back from turbo to flash to air for the haiku slot', () => {
    const withFlash = ['glm-5', 'glm-5-flash', 'glm-4.7-flashx']
    expect(selectModels(withFlash)?.haikuModel).toBe('glm-5-flash')

    const withAir = ['glm-5', 'glm-4.5-air']
    expect(selectModels(withAir)?.haikuModel).toBe('glm-4.5-air')

    const flagshipOnly = ['glm-5.1', 'glm-5']
    // No turbo/flash/air variant — haiku collapses onto the flagship
    expect(selectModels(flagshipOnly)?.haikuModel).toBe('glm-5.1')
  })

  test('treats minor versions correctly (5.1 beats 5.0 beats 4.7)', () => {
    const ids = ['glm-5', 'glm-5.1', 'glm-4.7']
    expect(selectModels(ids)?.sonnetModel).toBe('glm-5.1')
  })

  test('returns null when no flagship is recognizable', () => {
    expect(selectModels([])).toBeNull()
    expect(selectModels(['gpt-4', 'claude-3-opus'])).toBeNull()
    // Specialist long-context model isn't picked up as flagship by the regex (it has a suffix)
    expect(selectModels(['glm-4-32b-0414-128k'])).toBeNull()
  })

  test('ignores unrelated providers in a mixed list', () => {
    const ids = ['gpt-4o', 'glm-4.7', 'claude-3-5-sonnet', 'glm-5-turbo']
    expect(selectModels(ids)).toEqual({
      haikuModel: 'glm-5-turbo',
      sonnetModel: 'glm-4.7',
      opusModel: 'glm-4.7',
    })
  })
})
