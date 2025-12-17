-- Migration: Add Software Repository Discovery Tables
-- Version: 019
-- Description: Tables for tracking git repositories and their dependencies

-- Software repositories table
CREATE TABLE IF NOT EXISTS software_repositories (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL DEFAULT 'github',
    url VARCHAR(500) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    branch VARCHAR(100) DEFAULT 'main',
    auto_scan BOOLEAN DEFAULT true,
    scan_interval_hours INTEGER DEFAULT 24,
    auth_encrypted TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    last_scanned TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Software dependencies table
CREATE TABLE IF NOT EXISTS software_dependencies (
    id SERIAL PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES software_repositories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    version VARCHAR(100),
    type VARCHAR(50) NOT NULL,
    file_path VARCHAR(500),
    is_dev BOOLEAN DEFAULT false,
    license VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository_id, name, type)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_software_repositories_provider ON software_repositories(provider);
CREATE INDEX IF NOT EXISTS idx_software_repositories_status ON software_repositories(status);
CREATE INDEX IF NOT EXISTS idx_software_dependencies_repository ON software_dependencies(repository_id);
CREATE INDEX IF NOT EXISTS idx_software_dependencies_name ON software_dependencies(name);
CREATE INDEX IF NOT EXISTS idx_software_dependencies_type ON software_dependencies(type);

-- Comments
COMMENT ON TABLE software_repositories IS 'Git repositories connected for dependency discovery';
COMMENT ON TABLE software_dependencies IS 'Dependencies discovered from repository scans';
COMMENT ON COLUMN software_repositories.provider IS 'Git provider: github, gitlab, bitbucket, azure';
COMMENT ON COLUMN software_repositories.auth_encrypted IS 'Encrypted authentication credentials (PAT, tokens)';
COMMENT ON COLUMN software_repositories.status IS 'Scan status: pending, scanning, active, error';
COMMENT ON COLUMN software_dependencies.type IS 'Dependency type: npm, pip, go, cargo, maven, composer';
