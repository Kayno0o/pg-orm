/**
 * Calculate Levenshtein distance between two strings
 * Used for suggesting corrections in error messages
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length
  const len2 = str2.length

  // Create a matrix to store distances
  const matrix: number[][] = []

  // Initialize first column and row
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j
  }

  // Calculate distances
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1

      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1, // Deletion
        matrix[i]![j - 1]! + 1, // Insertion
        matrix[i - 1]![j - 1]! + cost, // Substitution
      )
    }
  }

  return matrix[len1]![len2]!
}

/**
 * Find the closest matches from a list of candidates
 * Returns suggestions with Levenshtein distance ≤ maxDistance
 */
export function findClosestMatches(
  input: string,
  candidates: string[],
  maxDistance = 2,
): string[] {
  const matches: { candidate: string, distance: number }[] = []

  for (const candidate of candidates) {
    const distance = levenshteinDistance(input.toLowerCase(), candidate.toLowerCase())

    if (distance <= maxDistance) {
      matches.push({ candidate, distance })
    }
  }

  // Sort by distance (closest first)
  matches.sort((a, b) => a.distance - b.distance)

  return matches.map(m => m.candidate)
}
