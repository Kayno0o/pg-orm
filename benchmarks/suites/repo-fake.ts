import type { FakeDb } from '../fake-db'
import type { ItemRepo } from './item-ops'
import { richItems } from '../item-schema'
import { defineSuite } from '../utils'
import { itemOps, plainRepo } from './item-ops'

export function repoFakeSuites(db: FakeDb) {
  const fake = db
  const nextDeleteId = () => 1

  return [
    defineSuite('repo-plain', itemOps({ repo: plainRepo(db), rich: false, fake, nextDeleteId })),
    defineSuite('repo-traits', itemOps({ repo: db.repo(richItems) as unknown as ItemRepo, rich: true, fake, nextDeleteId })),
  ]
}
