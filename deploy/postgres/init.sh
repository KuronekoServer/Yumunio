#!/bin/sh
set -eu
# Executed by the PostgreSQL image only when initializing a new, empty volume.
# psql literal quoting keeps password contents out of SQL syntax.
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$YUMUNIO_DB_PASSWORD" <<'SQL'
CREATE ROLE yumunio LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE yumunio TO yumunio;
GRANT USAGE, CREATE ON SCHEMA public TO yumunio;
SET ROLE yumunio;
\i /opt/yumunio-prototype.sql
SQL
