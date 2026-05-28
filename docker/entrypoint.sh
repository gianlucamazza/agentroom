#!/bin/sh
# entrypoint.sh — fix /data ownership before dropping to the node user
# Necessary because VOLUME mounts override Dockerfile RUN chown commands.
set -e

# Only chown if running as root (standard docker run) and /data exists
if [ "$(id -u)" = "0" ] && [ -d /data ]; then
	chown -R node:node /data
	exec su-exec node "$@"
else
	exec "$@"
fi
