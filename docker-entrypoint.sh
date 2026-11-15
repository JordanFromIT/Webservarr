#!/bin/sh
set -e
# Runs as root: make the bind-mounted volumes writable by the unprivileged app
# user, then exec supervisord (which runs redis and uvicorn as appuser, so an
# app compromise lands as a non-root user rather than root).
chown -R appuser:appuser /app/data /app/app/static/uploads 2>/dev/null || true
# Redis keeps sessions (and the service tokens in them) here: only appuser
# may read it. Created on first start, tightened on every start. Created as
# appuser (10001, see Dockerfile) so it works where root cannot chown (NFS
# root_squash, CIFS, user namespaces); a failure warns but never stops startup.
redis_dir=/app/data/redis
as_appuser() { setpriv --reuid=10001 --regid=10001 --clear-groups "$@"; }
as_appuser mkdir -p -m 700 "$redis_dir" 2>/dev/null || mkdir -p -m 700 "$redis_dir" 2>/dev/null \
    || echo "docker-entrypoint: warning: cannot create $redis_dir" >&2
chown appuser:appuser "$redis_dir" 2>/dev/null \
    || echo "docker-entrypoint: warning: cannot chown $redis_dir to appuser" >&2
chmod 700 "$redis_dir" 2>/dev/null || as_appuser chmod 700 "$redis_dir" 2>/dev/null \
    || echo "docker-entrypoint: warning: cannot chmod 700 $redis_dir" >&2
exec "$@"
