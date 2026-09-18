@echo off
REM Creates or updates the tables on Railway's Postgres from shared/schema.ts.
REM
REM WHY THIS FILE EXISTS
REM   drizzle-kit reads DATABASE_URL, and Railway's DATABASE_URL points at
REM   postgres.railway.internal, a host that only resolves inside Railway. Run from a laptop it
REM   fails with ENOTFOUND. DATABASE_PUBLIC_URL is the one that works from outside, and Railway
REM   injects it when the command runs through the CLI against the Postgres service — so the
REM   password is never pasted, printed, or stored anywhere.
REM
REM   PowerShell also refuses to run npm's .ps1 shims on this machine, hence npx.cmd.
REM
REM USE
REM   railway.cmd run --service Postgres cmd /c scripts\push-schema.cmd
REM
REM   Public access must be enabled on the Postgres service while this runs
REM   (Postgres -> Settings -> Networking -> Add Public Access). Turn it off afterwards: the app
REM   itself talks to the database over Railway's private network and doesn't need it.

if "%DATABASE_PUBLIC_URL%"=="" (
  echo.
  echo DATABASE_PUBLIC_URL is empty.
  echo Run this through the Railway CLI against the Postgres service:
  echo   railway.cmd run --service Postgres cmd /c scripts\push-schema.cmd
  echo And make sure Public Access is enabled on that service.
  exit /b 1
)

set DATABASE_URL=%DATABASE_PUBLIC_URL%
echo Pushing the schema to the public host...
npx.cmd drizzle-kit push
