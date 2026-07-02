-- Runs only on first initialization of a fresh postgres volume.
-- Existing volumes: run scripts/setup-mempalace.sh instead.
CREATE DATABASE mempalace;
\connect mempalace
CREATE EXTENSION IF NOT EXISTS vector;
