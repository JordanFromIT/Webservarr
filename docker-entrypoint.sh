#!/bin/sh
set -e
# Runs as root: make the bind-mounted volumes writable by the unprivileged app
# user, then exec supervisord (which runs redis and uvicorn as appuser, so an
# app compromise lands as a non-root user rather than root).
chown -R appuser:appuser /app/data /app/app/static/uploads 2>/dev/null || true
exec "$@"
