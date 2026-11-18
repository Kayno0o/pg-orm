import { afterAll } from 'bun:test'
import { dropFileDatabase } from './db'

afterAll(dropFileDatabase)
