import { normaliseList } from './extractIds.js';

/**
 * SQL fragment to extract first company ID from CIDS field
 * CIDS format: ",123,456," (with leading/trailing commas)
 * SQL Server 2008 compatible
 *
 * Usage: SELECT ${EXTRACT_FIRST_CID_SQL} AS first_cid FROM table p
 */
export const EXTRACT_FIRST_CID_SQL = `
  CASE
    WHEN LEN(SUBSTRING(p.CIDS, 2,
      CASE WHEN CHARINDEX(',', p.CIDS, 2) > 0
           THEN CHARINDEX(',', p.CIDS, 2) - 2
           ELSE LEN(p.CIDS) - 1
      END)) > 0
    AND ISNUMERIC(SUBSTRING(p.CIDS, 2,
      CASE WHEN CHARINDEX(',', p.CIDS, 2) > 0
           THEN CHARINDEX(',', p.CIDS, 2) - 2
           ELSE LEN(p.CIDS) - 1
      END)) = 1
    THEN CAST(SUBSTRING(p.CIDS, 2,
      CASE WHEN CHARINDEX(',', p.CIDS, 2) > 0
           THEN CHARINDEX(',', p.CIDS, 2) - 2
           ELSE LEN(p.CIDS) - 1
      END) AS BIGINT)
    ELSE NULL
  END
`;

/**
 * Get company details by CIDs
 * @param {object} pool - MSSQL connection pool
 * @param {Array<string|number>} cids - Array of company IDs
 * @returns {Promise<Map<string, {cid: string, name: string}>>} Map of cid -> company info
 */
export async function getCompaniesByCids(pool, cids) {
  const ids = normaliseList(cids, { coerce: 'string' });
  if (!ids.length) return new Map();

  // Use parameterized query to avoid SQL injection and handle large IDs
  const request = pool.request();
  const placeholders = ids.map((id, i) => {
    request.input(`cid${i}`, id);
    return `@cid${i}`;
  }).join(', ');

  const result = await request.query(`
    SELECT cid, name
    FROM a_rcCompany
    WHERE cid IN (${placeholders})
  `);

  const map = new Map();
  result.recordset.forEach(row => map.set(String(row.cid), { cid: row.cid, name: row.name }));
  return map;
}

/**
 * Extract first CID from CIDS string (JavaScript version)
 * @param {string} cids - Comma-separated CIDs like ",123,456,"
 * @returns {string|null} First CID as string or null
 */
/**
 * Build the "one brand row per company" SELECT.
 *
 * A company has many branch/department rows; a company CARD needs exactly one.
 * `ROW_NUMBER() PARTITION BY c.cid` picks it, preferring the row whose combined
 * picture tokens are shortest — the most canonical, least-overridden brand row,
 * which is bizchat's original rule and what makes the logo look right.
 *
 * WHY THIS IS SHARED. This query lived as three hand-maintained copies
 * (agentb/persistence.js, services/companyEnhanceQuery.js, and bizchat's
 * DBNegotiators.js). They drifted: a fix applied to one left the others wrong,
 * and the page kept rendering the bad value because the copy it actually ran
 * was not the copy that got patched. One builder, several callers.
 *
 * PREFER THE PROPERTY'S OWN DEPARTMENT. `phone` and `branch` ride along with
 * whichever row the picture tie-break lands on, and that is arbitrary when
 * lengths tie — BTG Eddisons has 40 branch rows, 30 tied at length 27, so its
 * listings showed Bradford's number under a "Kettering · Agency" label. Callers
 * that know the property's dids pass them, that row wins, and the revealed
 * phone belongs to the branch on screen. With no match it falls back to the
 * picture tie-break, so a property with missing/stale dids still renders a card.
 *
 * Column aliases (a/p/s/d/b/c) are what the frontend's company parser expects —
 * do not rename them without changing @4prop/property-enhance.
 *
 * The caller owns parameter binding: pass placeholder NAMES already bound on its
 * own request, so this module never touches a driver or a `sql` type object
 * (property-pub and bizchat run different mssql majors).
 *
 * @param {object} opts
 * @param {string} opts.filterColumn        'c.cid' or 'd.did' — what the caller filters on.
 * @param {string[]} opts.filterParams      Bound placeholders, e.g. ['@id0','@id1'].
 * @param {string[]} [opts.preferDidParams] Bound placeholders for the property's dids.
 * @returns {string} SQL returning phone, name, a, p, s, d, b, c, branch, department.
 */
export function buildCompanyBrandRowQuery({ filterColumn, filterParams, preferDidParams = [] }) {
  if (filterColumn !== 'c.cid' && filterColumn !== 'd.did') {
    throw new Error(`buildCompanyBrandRowQuery: unsupported filterColumn "${filterColumn}"`);
  }
  if (!Array.isArray(filterParams) || filterParams.length === 0) {
    throw new Error('buildCompanyBrandRowQuery: filterParams must be a non-empty array');
  }

  // Ordered FIRST so a matching department outranks the picture tie-break.
  const preferOrder = preferDidParams.length
    ? `CASE WHEN d.did IN (${preferDidParams.join(', ')}) THEN 0 ELSE 1 END ASC,`
    : '';

  return `
    WITH ranked AS (
      SELECT
        phone = b.phone,
        name  = c.name,
        a     = d.pics,
        p     = b.pics,
        s     = c.ps,
        d     = d.did,
        b     = b.bid,
        c     = c.cid,
        branch = b.name,
        department = d.name,
        rn = ROW_NUMBER() OVER (
          PARTITION BY c.cid
          ORDER BY
            ${preferOrder}
            LEN(ISNULL(d.pics, '') + ISNULL(b.pics, '') + ISNULL(c.ps, '')) ASC
        )
      FROM a_rcDepartment d
      INNER JOIN a_rpBranch b ON d.bid = b.bid
      INNER JOIN a_rcCompany c ON b.cid = c.cid
      WHERE ${filterColumn} IN (${filterParams.join(', ')})
    )
    SELECT phone, name, a, p, s, d, b, c, branch, department
    FROM ranked
    WHERE rn = 1
    ORDER BY name, branch
  `;
}

export function extractFirstCid(cids) {
  if (!cids || typeof cids !== 'string') return null;
  // CIDS format is ",123,456," - extract first number after leading comma
  const match = cids.match(/^,(\d+),/);
  return match ? match[1] : null;
}
