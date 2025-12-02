import type { SQL } from 'bun'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDatabase } from './db'

export interface SeederContext {
  db: SQL
}

export interface Seeder {
  name: string
  groups?: string[]
  run: (context: SeederContext) => Promise<void>
}

export class SeederRunner {
  private seedsPath: string

  constructor(seedsPath = 'seeds') {
    this.seedsPath = resolve(process.cwd(), seedsPath)
  }

  async run(options?: { seederNames?: string[], group?: string }): Promise<void> {
    const db = getDatabase()

    if (!existsSync(this.seedsPath)) {
      console.log(`\nSeeds directory not found: ${this.seedsPath}`)
      console.log('Create a seeds directory and add seeder files.')

      return
    }

    const files = readdirSync(this.seedsPath)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .sort()

    if (files.length === 0) {
      console.log('\nNo seed files found.')

      return
    }

    const seeders = await this.loadSeeders(files)

    let toRun = seeders

    // Filter by group if specified
    if (options?.group) {
      toRun = toRun.filter(s => s.groups?.includes(options.group!))
    }

    // Filter by names if specified
    if (options?.seederNames && options.seederNames.length > 0) {
      toRun = toRun.filter(s => options.seederNames!.includes(s.name))
    }

    if (toRun.length === 0) {
      console.log('\nNo matching seeders found.')

      return
    }

    console.log(`\nRunning ${toRun.length} seeder(s)...\n`)

    for (const seeder of toRun) {
      const groupInfo = seeder.groups ? ` [${seeder.groups.join(', ')}]` : ''

      console.log(`  → ${seeder.name}${groupInfo}`)

      try {
        await seeder.run({ db })
        console.log(`    ✓ Completed`)
      }
      catch (error) {
        console.error(`    ✗ Failed: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    }

    console.log('\n✓ All seeders completed successfully\n')
  }

  private async loadSeeders(files: string[]): Promise<Seeder[]> {
    const seeders: Seeder[] = []

    for (const file of files) {
      const filePath = resolve(this.seedsPath, file)

      try {
        const module = await import(filePath)
        const seeder: Seeder = module.default || module

        if (!seeder.name || typeof seeder.run !== 'function') {
          console.warn(`⚠ Skipping ${file}: Must export { name, run } or default export with those properties`)

          continue
        }

        seeders.push(seeder)
      }
      catch (error) {
        console.error(`Failed to load seeder ${file}:`, error)
        throw error
      }
    }

    return seeders
  }

  async listSeeders(): Promise<void> {
    if (!existsSync(this.seedsPath)) {
      console.log(`\nSeeds directory not found: ${this.seedsPath}`)

      return
    }

    const files = readdirSync(this.seedsPath)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .sort()

    if (files.length === 0) {
      console.log('\nNo seed files found.')

      return
    }

    console.log('\nAvailable seeders:\n')

    const groupedSeeders = new Map<string, Seeder[]>()
    const ungrouped: Seeder[] = []

    for (const file of files) {
      const filePath = resolve(this.seedsPath, file)

      try {
        const module = await import(filePath)
        const seeder: Seeder = module.default || module

        if (!seeder.groups || seeder.groups.length === 0) {
          ungrouped.push(seeder)

          continue
        }

        for (const group of seeder.groups) {
          if (!groupedSeeders.has(group)) {
            groupedSeeders.set(group, [])
          }

          groupedSeeders.get(group)!.push(seeder)
        }
      }
      catch {
        console.log(`  • ${file} (invalid)`)
      }
    }

    // Display grouped seeders
    for (const [group, seeders] of groupedSeeders) {
      console.log(`  [${group}]`)

      for (const seeder of seeders) {
        console.log(`    • ${seeder.name}`)
      }
    }

    // Display ungrouped seeders
    if (ungrouped.length > 0) {
      if (groupedSeeders.size > 0) {
        console.log('\n  [no group]')
      }

      for (const seeder of ungrouped) {
        console.log(`    • ${seeder.name}`)
      }
    }

    console.log()
  }
}
