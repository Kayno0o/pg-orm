fix:
  bun run circular
  bun run check
  bun run lint:fix
  bun run llms
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
patch: (release "patch")

# v0.X.0
minor: (release "minor")

# vX.0.0
major: (release "major")

# bump, then push the branch and its new tag in one atomic push; a rejected push drops the bump so a retry starts clean
release level:
	#!/usr/bin/env bash
	set -euo pipefail
	npm version {{level}}
	tag=$(git tag --points-at HEAD)
	if ! git push --atomic origin HEAD "$tag"; then
	  git tag -d "$tag"
	  git reset --keep HEAD~1
	  exit 1
	fi
