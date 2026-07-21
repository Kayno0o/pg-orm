fix:
  bun run circular
  bun run check
  bun run lint:fix
  bun run build

# start PG, run the suite (any `bun test` args are forwarded), stop PG
test *args:
  #!/usr/bin/env bash
  bun run db:up
  bun test {{args}}
  status=$?
  bun run db:down
  exit $status

bench:
  bash bench.sh

# v0.0.X
patch:
	npm version patch
	git push
	git push --tags

# v0.X.0
minor:
	npm version minor
	git push
	git push --tags

# vX.0.0
major:
	npm version major
	git push
	git push --tags
