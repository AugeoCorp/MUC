#!/bin/sh
# Launch `muc agent` in the background and print two JSON lines once it's up:
# the client's own {"listening": <port>, ...} handshake, then
# {"pid": <pid>, "logs": <dir>} — the directory holding the client's
# stdout/stderr for later inspection. The client keeps running after this
# script exits; stop it with POST /cmd {"op":"quit"} or `kill <pid>`.
#
# Usage: start.sh <code> [--handle NAME] [--descriptor TEXT] [--port N]
#
# Resolution order: a `muc` on PATH, else the published @augeo/muc from the
# npm registry, else npx against the GitHub repo. A first npx run installs
# (and for the GitHub fallback, builds) — allow a couple of minutes.
set -eu

if [ "$#" -lt 1 ]; then
	echo "usage: start.sh <code> [--handle NAME] [--descriptor TEXT] [--port N]" >&2
	exit 2
fi

logs_directory="$(mktemp -d)"
stdout_file="$logs_directory/stdout"
stderr_file="$logs_directory/stderr"
# Created up front so the wait loop below never races the background job's
# own opening of them.
: >"$stdout_file"
: >"$stderr_file"

if command -v muc >/dev/null 2>&1; then
	nohup muc agent "$@" >"$stdout_file" 2>"$stderr_file" &
elif npm view @augeo/muc version >/dev/null 2>&1; then
	nohup npx -y @augeo/muc agent "$@" >"$stdout_file" 2>"$stderr_file" &
else
	# Pre-publish only: builds whatever the default branch holds. Once
	# @augeo/muc is on npm this branch is never reached, and can go.
	nohup npx -y github:AugeoCorp/MUC agent "$@" >"$stdout_file" 2>"$stderr_file" &
fi
pid=$!

# Wait for the handshake (or the process dying trying). `read` succeeds only
# on a complete newline-terminated line, so a half-written one is never
# printed.
elapsed=0
while [ "$elapsed" -lt 300 ]; do
	if IFS= read -r handshake <"$stdout_file" 2>/dev/null; then
		printf '%s\n' "$handshake"
		printf '{"pid": %d, "logs": "%s"}\n' "$pid" "$logs_directory"
		exit 0
	fi
	if ! kill -0 "$pid" 2>/dev/null; then
		cat "$stderr_file" >&2
		exit 1
	fi
	sleep 1
	elapsed=$((elapsed + 1))
done

echo "timed out waiting for muc agent to start (logs: $logs_directory)" >&2
kill "$pid" 2>/dev/null || true
exit 1
