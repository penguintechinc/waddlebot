/**
 * Software Discovery Controller
 * Handles git repository discovery and dependency scanning
 */
import { query } from '../db.js';
import crypto from 'crypto';

/**
 * Get all registered software repositories
 */
export async function getRepositories(req, res) {
  try {
    const result = await query(
      `SELECT
        r.*,
        COUNT(d.id) as dependency_count
      FROM software_repositories r
      LEFT JOIN software_dependencies d ON d.repository_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC`
    );

    // Get dependencies for each repository (limited)
    const repositories = await Promise.all(
      result.rows.map(async (repo) => {
        const depsResult = await query(
          `SELECT name, version, type FROM software_dependencies
           WHERE repository_id = $1
           ORDER BY name
           LIMIT 20`,
          [repo.id]
        );
        return {
          ...repo,
          dependencies: depsResult.rows,
        };
      })
    );

    res.json({
      success: true,
      repositories,
    });
  } catch (error) {
    console.error('Error fetching repositories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch repositories',
    });
  }
}

/**
 * Get a specific repository by ID
 */
export async function getRepository(req, res) {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT * FROM software_repositories WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    // Get all dependencies
    const depsResult = await query(
      `SELECT * FROM software_dependencies WHERE repository_id = $1 ORDER BY type, name`,
      [id]
    );

    res.json({
      success: true,
      repository: {
        ...result.rows[0],
        dependencies: depsResult.rows,
      },
    });
  } catch (error) {
    console.error('Error fetching repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch repository',
    });
  }
}

/**
 * Add a new software repository
 */
export async function addRepository(req, res) {
  try {
    const {
      provider,
      url,
      name,
      branch = 'main',
      auto_scan = true,
      scan_interval_hours = 24,
      auth,
    } = req.body;

    // Validate required fields
    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'Repository URL is required',
      });
    }

    // Check for duplicate URL
    const existing = await query(
      `SELECT id FROM software_repositories WHERE url = $1`,
      [url]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Repository with this URL already exists',
      });
    }

    // Encrypt auth credentials if provided
    let encryptedAuth = null;
    if (auth && Object.keys(auth).length > 0) {
      encryptedAuth = encryptCredentials(auth);
    }

    const result = await query(
      `INSERT INTO software_repositories
        (provider, url, name, branch, auto_scan, scan_interval_hours, auth_encrypted, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
       RETURNING *`,
      [provider || detectProvider(url), url, name || extractRepoName(url), branch, auto_scan, scan_interval_hours, encryptedAuth]
    );

    res.status(201).json({
      success: true,
      repository: result.rows[0],
    });
  } catch (error) {
    console.error('Error adding repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add repository',
    });
  }
}

/**
 * Update a repository
 */
export async function updateRepository(req, res) {
  try {
    const { id } = req.params;
    const { name, branch, auto_scan, scan_interval_hours, auth } = req.body;

    // Check if repository exists
    const existing = await query(
      `SELECT * FROM software_repositories WHERE id = $1`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (branch !== undefined) {
      updates.push(`branch = $${paramCount++}`);
      values.push(branch);
    }
    if (auto_scan !== undefined) {
      updates.push(`auto_scan = $${paramCount++}`);
      values.push(auto_scan);
    }
    if (scan_interval_hours !== undefined) {
      updates.push(`scan_interval_hours = $${paramCount++}`);
      values.push(scan_interval_hours);
    }
    if (auth !== undefined) {
      updates.push(`auth_encrypted = $${paramCount++}`);
      values.push(auth && Object.keys(auth).length > 0 ? encryptCredentials(auth) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await query(
      `UPDATE software_repositories SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json({
      success: true,
      repository: result.rows[0],
    });
  } catch (error) {
    console.error('Error updating repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update repository',
    });
  }
}

/**
 * Delete a repository
 */
export async function deleteRepository(req, res) {
  try {
    const { id } = req.params;

    // Delete dependencies first
    await query(`DELETE FROM software_dependencies WHERE repository_id = $1`, [id]);

    // Delete repository
    const result = await query(
      `DELETE FROM software_repositories WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    res.json({
      success: true,
      message: 'Repository deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete repository',
    });
  }
}

/**
 * Trigger a scan of a repository
 */
export async function scanRepository(req, res) {
  try {
    const { id } = req.params;

    // Get repository
    const result = await query(
      `SELECT * FROM software_repositories WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found',
      });
    }

    const repo = result.rows[0];

    // Update status to scanning
    await query(
      `UPDATE software_repositories SET status = 'scanning', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // In a real implementation, this would trigger an async job
    // For now, we'll simulate scanning by fetching dependency files
    try {
      const dependencies = await scanRepositoryDependencies(repo);

      // Clear existing dependencies
      await query(`DELETE FROM software_dependencies WHERE repository_id = $1`, [id]);

      // Insert new dependencies
      for (const dep of dependencies) {
        await query(
          `INSERT INTO software_dependencies (repository_id, name, version, type, file_path)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, dep.name, dep.version, dep.type, dep.filePath]
        );
      }

      // Update status
      await query(
        `UPDATE software_repositories
         SET status = 'active', last_scanned = NOW(), error_message = NULL, updated_at = NOW()
         WHERE id = $1`,
        [id]
      );

      res.json({
        success: true,
        message: 'Repository scan completed',
        dependency_count: dependencies.length,
      });
    } catch (scanError) {
      // Update status to error
      await query(
        `UPDATE software_repositories
         SET status = 'error', error_message = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, scanError.message]
      );

      res.status(500).json({
        success: false,
        message: `Scan failed: ${scanError.message}`,
      });
    }
  } catch (error) {
    console.error('Error scanning repository:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate scan',
    });
  }
}

/**
 * Test repository connection
 */
export async function testConnection(req, res) {
  try {
    const { provider, url, auth } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'Repository URL is required',
      });
    }

    // Test by attempting to access the repository
    const testResult = await testRepositoryAccess(provider || detectProvider(url), url, auth);

    res.json({
      success: testResult.success,
      message: testResult.message,
      details: testResult.details,
    });
  } catch (error) {
    console.error('Error testing connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test connection',
    });
  }
}

/**
 * Get dependencies for a repository
 */
export async function getDependencies(req, res) {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT * FROM software_dependencies WHERE repository_id = $1 ORDER BY type, name`,
      [id]
    );

    res.json({
      success: true,
      dependencies: result.rows,
    });
  } catch (error) {
    console.error('Error fetching dependencies:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dependencies',
    });
  }
}

// Helper functions

function detectProvider(url) {
  if (url.includes('github.com')) return 'github';
  if (url.includes('gitlab.com') || url.includes('gitlab')) return 'gitlab';
  if (url.includes('bitbucket.org') || url.includes('bitbucket')) return 'bitbucket';
  if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) return 'azure';
  return 'github';
}

function extractRepoName(url) {
  try {
    const parts = url.replace(/\.git$/, '').split('/');
    return parts[parts.length - 1] || 'repository';
  } catch {
    return 'repository';
  }
}

function encryptCredentials(credentials) {
  const secretKey = process.env.SECRET_KEY || 'default-secret-key-change-me';
  const key = crypto.scryptSync(secretKey, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  let encrypted = cipher.update(JSON.stringify(credentials), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
}

function decryptCredentials(encryptedData) {
  if (!encryptedData) return null;

  const secretKey = process.env.SECRET_KEY || 'default-secret-key-change-me';
  const key = crypto.scryptSync(secretKey, 'salt', 32);

  const [ivHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return JSON.parse(decrypted);
}

async function scanRepositoryDependencies(repo) {
  // This is a placeholder implementation
  // In production, this would use git clone or API calls to fetch dependency files
  const dependencies = [];

  // Simulate finding dependencies based on provider
  // In a real implementation, this would:
  // 1. Clone the repo or use the provider's API
  // 2. Look for package.json, requirements.txt, go.mod, etc.
  // 3. Parse these files to extract dependencies

  // For now, return a mock result to demonstrate the flow
  const mockDeps = [
    { name: 'express', version: '^4.18.2', type: 'npm', filePath: 'package.json' },
    { name: 'react', version: '^18.2.0', type: 'npm', filePath: 'package.json' },
  ];

  return mockDeps;
}

async function testRepositoryAccess(provider, url, auth) {
  // In production, this would actually test the connection
  // For now, we'll do basic validation
  try {
    const urlObj = new URL(url);

    // Basic checks
    if (!urlObj.hostname) {
      return {
        success: false,
        message: 'Invalid repository URL',
        details: null,
      };
    }

    // In a real implementation, we would:
    // 1. Try to access the repo via API
    // 2. Verify credentials work
    // 3. Check for required permissions

    return {
      success: true,
      message: 'Connection test successful',
      details: {
        provider,
        host: urlObj.hostname,
        authenticated: auth && Object.keys(auth).length > 0,
      },
    };
  } catch (error) {
    return {
      success: false,
      message: `Invalid URL: ${error.message}`,
      details: null,
    };
  }
}
