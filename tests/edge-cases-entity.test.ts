import { describe, expect, test } from 'bun:test'
import { createTrait, softDelete, timestamps } from '../src'
import { InvalidIdentifierError } from '../src/errors'
import { orm } from './setup'

describe('Edge Cases - Entity Definition', () => {
  test('should handle entity with single field', () => {
    expect(() => {
      orm.entity('single_field', {
        name: orm.string(),
      }).build()
    }).not.toThrow()
  })

  test('should handle entity with many fields', () => {
    expect(() => {
      const fields: any = {}

      for (let i = 0; i < 50; i++) {
        fields[`field${i}`] = orm.string()
      }
      orm.entity('many_fields', fields).build()
    }).not.toThrow()
  })

  test('should reject invalid table names', () => {
    expect(() => {
      orm.entity('users; DROP TABLE users; --', {
        name: orm.string(),
      }).build()
    }).toThrow(InvalidIdentifierError)

    expect(() => {
      orm.entity('123invalid', {
        name: orm.string(),
      }).build()
    }).toThrow(InvalidIdentifierError)

    expect(() => {
      orm.entity('user-table', {
        name: orm.string(),
      }).build()
    }).toThrow(InvalidIdentifierError)
  })

  test('should accept valid table names', () => {
    expect(() => {
      orm.entity('users', { name: orm.string() }).build()
    }).not.toThrow()

    expect(() => {
      orm.entity('user_profiles', { name: orm.string() }).build()
    }).not.toThrow()

    expect(() => {
      orm.entity('UserData', { name: orm.string() }).build()
    }).not.toThrow()

    expect(() => {
      orm.entity('_private', { name: orm.string() }).build()
    }).not.toThrow()
  })

  test('should reject table names exceeding 63 characters', () => {
    expect(() => {
      orm.entity('a'.repeat(64), {
        name: orm.string(),
      }).build()
    }).toThrow(InvalidIdentifierError)
  })

  test('should accept table names with exactly 63 characters', () => {
    expect(() => {
      orm.entity('a'.repeat(63), {
        name: orm.string(),
      }).build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Field Definitions', () => {
  test('should handle all field types together', () => {
    expect(() => {
      orm.entity('all_types', {
        stringField: orm.string(),
        numberField: orm.number(),
        booleanField: orm.boolean(),
        jsonField: orm.json<any>(),
        jsonbField: orm.jsonb<any>(),
        uuidField: orm.uuid(),
        timestampField: orm.timestamp(),
        dateField: orm.date(),
        arrayStringField: orm.array('string'),
        arrayNumberField: orm.array('number'),
        arrayBooleanField: orm.array('boolean'),
        enumField: orm.enum(['a', 'b', 'c']),
        blobField: orm.blob(),
      }).build()
    }).not.toThrow()
  })

  test('should handle nullable fields', () => {
    expect(() => {
      orm.entity('nullable_test', {
        required: orm.string(),
        optional: orm.string().nullable(),
        optionalNumber: orm.number().nullable(),
        optionalBool: orm.boolean().nullable(),
      }).build()
    }).not.toThrow()
  })

  test('should handle fields with defaults', () => {
    expect(() => {
      orm.entity('defaults_test', {
        name: orm.string().default('Anonymous'),
        count: orm.number().default(0),
        active: orm.boolean().default(true),
        tags: orm.array('string').default([]),
        createdAt: orm.timestamp().default('NOW()'),
      }).build()
    }).not.toThrow()
  })

  test('should handle fields with constraints', () => {
    expect(() => {
      orm.entity('constraints_test', {
        username: orm.string().minLength(3).maxLength(20).unique(),
        age: orm.number().min(0).max(150),
        email: orm.string().unique(),
      }).build()
    }).not.toThrow()
  })

  test('should handle custom column names', () => {
    expect(() => {
      orm.entity('custom_columns', {
        firstName: orm.string().column('first_name'),
        lastName: orm.string().column('last_name'),
        emailAddr: orm.string().column('email'),
      }).build()
    }).not.toThrow()
  })

  test('should reject invalid column names', () => {
    expect(() => {
      orm.entity('invalid_columns', {
        name: orm.string().column('user; DROP'),
      }).build()
    }).toThrow(InvalidIdentifierError)
  })

  test('should handle enum with single value', () => {
    expect(() => {
      orm.entity('single_enum', {
        status: orm.enum(['active']),
      }).build()
    }).not.toThrow()
  })

  test('should handle enum with many values', () => {
    expect(() => {
      const values = Array.from({ length: 100 }, (_, i) => `value${i}`)

      orm.entity('many_enum', {
        status: orm.enum(values as any),
      }).build()
    }).not.toThrow()
  })

  test('should handle very long string maxLength', () => {
    expect(() => {
      orm.entity('long_string', {
        content: orm.string().maxLength(1000000),
      }).build()
    }).not.toThrow()
  })

  test('should handle number constraints at boundaries', () => {
    expect(() => {
      orm.entity('number_boundaries', {
        count: orm.number().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      }).build()
    }).not.toThrow()
  })

  test('should handle foreign key references', () => {
    expect(() => {
      orm.entity('posts', {
        title: orm.string(),
        authorId: orm.foreignKey('users'),
      }).build()
    }).not.toThrow()
  })

  test('should handle foreign key with custom column', () => {
    expect(() => {
      orm.entity('comments', {
        content: orm.string(),
        postId: orm.foreignKey('posts', 'id'),
      }).build()
    }).not.toThrow()
  })

  test('should handle foreign key with CASCADE options', () => {
    expect(() => {
      orm.entity('likes', {
        userId: orm.foreignKey('users').onDelete('CASCADE'),
        postId: orm.foreignKey('posts').onDelete('CASCADE').onUpdate('CASCADE'),
      }).build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Lifecycle Hooks', () => {
  test('should handle multiple beforeCreate hooks', () => {
    expect(() => {
      orm.entity('multi_hooks', {
        name: orm.string(),
        email: orm.string(),
      })
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
      orm.entity('all_hooks', {
        name: orm.string(),
      })
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
      orm.entity('async_hooks', {
        name: orm.string(),
      })
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
      orm.entity('no_traits', {
        name: orm.string(),
      }).build()
    }).not.toThrow()
  })

  test('should handle entity with single trait', () => {
    expect(() => {
      orm.entity('single_trait', {
        name: orm.string(),
      })
        .use(timestamps())
        .build()
    }).not.toThrow()
  })

  test('should handle entity with multiple traits', () => {
    expect(() => {
      orm.entity('multi_traits', {
        name: orm.string(),
      })
        .use(timestamps())
        .use(softDelete())
        .build()
    }).not.toThrow()
  })

  test('should handle custom traits', () => {
    expect(() => {
      const customTrait = createTrait()
        .fields({
          customField: orm.string(),
        })
        .methods({})
        .build()

      orm.entity('custom_trait', {
        name: orm.string(),
      })
        .use(customTrait)
        .build()
    }).not.toThrow()
  })
})

describe('Edge Cases - Unique Constraints', () => {
  test('should handle single unique field', () => {
    expect(() => {
      orm.entity('single_unique', {
        email: orm.string().unique(),
      }).build()
    }).not.toThrow()
  })

  test('should handle multiple unique fields', () => {
    expect(() => {
      orm.entity('multi_unique', {
        email: orm.string().unique(),
        username: orm.string().unique(),
        phone: orm.string().unique(),
      }).build()
    }).not.toThrow()
  })

  test('should handle composite unique constraints', () => {
    expect(() => {
      orm.entity('composite_unique', {
        firstName: orm.string(),
        lastName: orm.string(),
        email: orm.string(),
      })
        .unique(['firstName', 'lastName'])
        .unique(['email'])
        .build()
    }).not.toThrow()
  })
})
