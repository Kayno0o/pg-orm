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
  bun run test {{args}}
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
	  # origin has two push URLs, atomic only within each: once Forgejo holds the tag the release is published, so keep the bump and finish the other remote.
	  if git ls-remote --exit-code origin "refs/tags/$tag" >/dev/null; then
	    echo "$tag is on Forgejo and published; rerun: git push --atomic origin HEAD $tag" >&2
	    exit 1
	  fi
	  git tag -d "$tag"
	  git reset --keep HEAD~1
	  exit 1
	fi
