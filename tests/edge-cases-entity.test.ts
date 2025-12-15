import { describe, expect, test } from 'bun:test'
import { createTrait, softDelete, timestamps } from '../src'
import { InvalidIdentifierError } from '../src/errors'
import { orm } from './setup'

describe('Edge Cases - Entity Definition', () => {
  test('should handle entity with single field', () => {
    expect(() => {
      orm.entity('single_field', f => ({
        name: f.string(),
      })).build()
    }).not.toThrow()
  })

  test('should handle entity with many fields', () => {
    expect(() => {
      orm.entity('many_fields', (f) => {
        const fields: any = {}

        for (let i = 0; i < 50; i++) {
          fields[`field${i}`] = f.string()
        }

        return fields
      }).build()
    }).not.toThrow()
  })

  test('should reject invalid table names', () => {
    expect(() => {
      orm.entity('users; DROP TABLE users; --', f => ({
        name: f.string(),
      })).build()
    }).toThrow(InvalidIdentifierError)

    expect(() => {
      orm.entity('123invalid', f => ({
        name: f.string(),
      })).build()
    }).toThrow(InvalidIdentifierError)

    expect(() => {
      orm.entity('user-table', f => ({
        name: f.string(),
      })).build()
    }).toThrow(InvalidIdentifierError)
  })

  test('should accept valid table names', () => {
    expect(() => {
      orm.entity('users', f => ({ name: f.string() })).build()
    }).not.toThrow()

    expect(() => {
      orm.entity('user_profiles', f => ({ name: f.string() })).build()
    }).not.toThrow()

    expect(() => {
      orm.entity('UserData', f => ({ name: f.string() })).build()
    }).not.toThrow()

    expect(() => {
      orm.entity('_private', f => ({ name: f.string() })).build()
    }).not.toThrow()
  })

  test('should reject table names exceeding 63 characters', () => {
    expect(() => {
      orm.entity('a'.repeat(64), f => ({
        name: f.string(),
      })).build()
    }).toThrow(InvalidIdentifierError)
  })

  test('should accept table names with exactly 63 characters', () => {
    expect(() => {
      orm.entity('a'.repeat(63), f => ({
        name: f.string(),
      })).build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Field Definitions', () => {
  test('should handle all field types together', () => {
    expect(() => {
      orm.entity('all_types', f => ({
        stringField: f.string(),
        numberField: f.number(),
        booleanField: f.boolean(),
        jsonField: f.json<any>(),
        jsonbField: f.jsonb<any>(),
        uuidField: f.uuid(),
        timestampField: f.timestamp(),
        dateField: f.date(),
        arrayStringField: f.array('string'),
        arrayNumberField: f.array('number'),
        arrayBooleanField: f.array('boolean'),
        enumField: f.enum(['a', 'b', 'c']),
        blobField: f.blob(),
      })).build()
    }).not.toThrow()
  })

  test('should handle nullable fields', () => {
    expect(() => {
      orm.entity('nullable_test', f => ({
        required: f.string(),
        optional: f.string().nullable(),
        optionalNumber: f.number().nullable(),
        optionalBool: f.boolean().nullable(),
      })).build()
    }).not.toThrow()
  })

  test('should handle fields with defaults', () => {
    expect(() => {
      orm.entity('defaults_test', f => ({
        name: f.string().default('Anonymous'),
        count: f.number().default(0),
        active: f.boolean().default(true),
        tags: f.array('string').default([]),
        createdAt: f.timestamp().default('NOW()'),
      })).build()
    }).not.toThrow()
  })

  test('should handle fields with constraints', () => {
    expect(() => {
      orm.entity('constraints_test', f => ({
        username: f.string().minLength(3).maxLength(20).unique(),
        age: f.number().min(0).max(150),
        email: f.string().unique(),
      })).build()
    }).not.toThrow()
  })

  test('should handle custom column names', () => {
    expect(() => {
      orm.entity('custom_columns', f => ({
        firstName: f.string().column('first_name'),
        lastName: f.string().column('last_name'),
        emailAddr: f.string().column('email'),
      })).build()
    }).not.toThrow()
  })

  test('should reject invalid column names', () => {
    expect(() => {
      orm.entity('invalid_columns', f => ({
        name: f.string().column('user; DROP'),
      })).build()
    }).toThrow(InvalidIdentifierError)
  })

  test('should handle enum with single value', () => {
    expect(() => {
      orm.entity('single_enum', f => ({
        status: f.enum(['active']),
      })).build()
    }).not.toThrow()
  })

  test('should handle enum with many values', () => {
    expect(() => {
      const values = Array.from({ length: 100 }, (_, i) => `value${i}`)

      orm.entity('many_enum', f => ({
        status: f.enum(values),
      })).build()
    }).not.toThrow()
  })

  test('should handle very long string maxLength', () => {
    expect(() => {
      orm.entity('long_string', f => ({
        content: f.string().maxLength(1000000),
      })).build()
    }).not.toThrow()
  })

  test('should handle number constraints at boundaries', () => {
    expect(() => {
      orm.entity('number_boundaries', f => ({
        count: f.number().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      })).build()
    }).not.toThrow()
  })

  test('should handle foreign key references', () => {
    expect(() => {
      orm.entity('posts', f => ({
        title: f.string(),
        authorId: f.foreignKey('users'),
      })).build()
    }).not.toThrow()
  })

  test('should handle foreign key with custom column', () => {
    expect(() => {
      orm.entity('comments', f => ({
        content: f.string(),
        postId: f.foreignKey('posts', 'id'),
      })).build()
    }).not.toThrow()
  })

  test('should handle foreign key with CASCADE options', () => {
    expect(() => {
      orm.entity('likes', f => ({
        userId: f.foreignKey('users').onDelete('CASCADE'),
        postId: f.foreignKey('posts').onDelete('CASCADE').onUpdate('CASCADE'),
      })).build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Lifecycle Hooks', () => {
  test('should handle multiple beforeCreate hooks', () => {
    expect(() => {
      orm.entity('multi_hooks', f => ({
        name: f.string(),
        email: f.string(),
      }))
        .beforeCreate((data) => {
          data.name = data.name.trim()
        })
        .beforeCreate((data) => {
          data.email = data.email.toLowerCase()
        })
        .build()
    }).not.toThrow()
  })

  test('should handle all hook types', () => {
    expect(() => {
      orm.entity('all_hooks', f => ({
        name: f.string(),
      }))
        // eslint-disable-next-line ts/no-empty-function
        .beforeCreate((_data) => {})
        // eslint-disable-next-line ts/no-empty-function
        .afterCreate(async (_entity) => {})
        // eslint-disable-next-line ts/no-empty-function
        .beforeUpdate((_id, _data) => {})
        // eslint-disable-next-line ts/no-empty-function
        .afterUpdate(async (_entity) => {})
        // eslint-disable-next-line ts/no-empty-function
        .beforeDelete(async (_id) => {})
        // eslint-disable-next-line ts/no-empty-function
        .afterDelete(async (_id) => {})
        .build()
    }).not.toThrow()
  })

  test('should handle hooks with async operations', () => {
    expect(() => {
      orm.entity('async_hooks', f => ({
        name: f.string(),
      }))
        .afterCreate(async (_entity) => {
          await new Promise(resolve => setTimeout(resolve, 1))
        })
        .build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Traits', () => {
  test('should handle entity with no traits', () => {
    expect(() => {
      orm.entity('no_traits', f => ({
        name: f.string(),
      })).build()
    }).not.toThrow()
  })

  test('should handle entity with single trait', () => {
    expect(() => {
      orm.entity('single_trait', f => ({
        name: f.string(),
      }))
        .use(timestamps())
        .build()
    }).not.toThrow()
  })

  test('should handle entity with multiple traits', () => {
    expect(() => {
      orm.entity('multi_traits', f => ({
        name: f.string(),
      }))
        .use(timestamps())
        .use(softDelete())
        .build()
    }).not.toThrow()
  })

  test('should handle custom traits', () => {
    expect(() => {
      const customTrait = createTrait()
        .fields(f => ({
          customField: f.string(),
        }))
        .methods({})
        .build()

      orm.entity('custom_trait', f => ({
        name: f.string(),
      }))
        .use(customTrait)
        .build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Unique Constraints', () => {
  test('should handle single unique field', () => {
    expect(() => {
      orm.entity('single_unique', f => ({
        email: f.string().unique(),
      })).build()
    }).not.toThrow()
  })

  test('should handle multiple unique fields', () => {
    expect(() => {
      orm.entity('multi_unique', f => ({
        email: f.string().unique(),
        username: f.string().unique(),
        phone: f.string().unique(),
      })).build()
    }).not.toThrow()
  })

  test('should handle composite unique constraints', () => {
    expect(() => {
      orm.entity('composite_unique', f => ({
        firstName: f.string(),
        lastName: f.string(),
        email: f.string(),
      }))
        .unique(['firstName', 'lastName'])
        .unique(['email'])
        .build()
    }).not.toThrow()
  })
})
