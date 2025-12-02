import type { SQL } from 'bun'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { getDatabase } from './db'

export interface SeederContext {
  db: SQL
}

export interface Seeder {
  name: string
  run: (context: SeederContext) => Promise<void>
}

export class SeederRunner {
  private seedsPath: string

  constructor(seedsPath = 'seeds') {
    this.seedsPath = resolve(process.cwd(), seedsPath)
  }

  async run(seederNames?: string[]): Promise<void> {
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

    const toRun = seederNames
      ? seeders.filter(s => seederNames.includes(s.name))
      : seeders

    if (toRun.length === 0) {
      console.log('\nNo matching seeders found.')

      return
    }

    console.log(`\nRunning ${toRun.length} seeder(s)...\n`)

    for (const seeder of toRun) {
      try {
        console.log(`  → ${seeder.name}`)
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

    for (const file of files) {
      const filePath = resolve(this.seedsPath, file)

      try {
        const module = await import(filePath)
        const seeder: Seeder = module.default || module

        console.log(`  • ${seeder.name || file}`)
      }
      catch {
        console.log(`  • ${file} (invalid)`)
      }
    }

    console.log()
  }
}
