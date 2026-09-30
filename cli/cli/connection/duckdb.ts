import { execFile } from 'node:child_process';
import { getMotherduckToJsType } from '@evidence/core/connectors/motherduck/type-mapping';
import { normalizeDateRows } from '@evidence/core/connectors/postgres/normalize-date-rows';
import { normalizeNumericRows } from '@evidence/core/connectors/postgres/normalize-numeric-rows';
import { normalizeSparklineRows } from '@evidence/core/connectors/normalize-sparkline-rows';
import type { DuckDBConnectionConfig, QueryResult } from './types';

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const quoteString = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Each query gets an isolated process and temporary views; database files are opened read-only. */
export async function executeDuckDBQuery(
	sql: string,
	config: DuckDBConnectionConfig
): Promise<QueryResult> {
	const sources = Object.entries(config.sources).map(([name, source]) => {
		const paths = Array.isArray(source.path) ? source.path : [source.path];
		const reader = { parquet: 'read_parquet', csv: 'read_csv_auto', json: 'read_json_auto' }[
			source.format
		];
		return `CREATE TEMP VIEW ${quoteIdentifier(name)} AS SELECT * FROM ${reader}([${paths.map(quoteString).join(', ')}]);`;
	});
	// DESCRIBE binds the query without executing it, preserving empty-result
	// metadata without adding an internal view to catalog queries.
	const query = sql.trim().replace(/;+\s*$/, '');
	const script = `${sources.join('\n')}
SELECT json_object(
  'columns', (SELECT json_group_array(json_object('name', column_name, 'type', column_type)) FROM (DESCRIBE
${query}
)),
  'rows', (SELECT coalesce(to_json(list(t)), '[]'::JSON) FROM (
${query}
) t)
)::VARCHAR AS result;
`;
	const args = [
		'-batch',
		'-bail',
		'-json',
		'-init',
		process.platform === 'win32' ? 'NUL' : '/dev/null'
	];
	if (config.database !== ':memory:') args.push('-readonly');
	args.push(config.database);
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = execFile(
			config.executable,
			args,
			{ cwd: config.cwd, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							(error as NodeJS.ErrnoException).code === 'ENOENT'
								? `DuckDB executable not found: ${config.executable}. Install DuckDB on the server or set executable in connection.yaml.`
								: `DuckDB query failed: ${stderr.trim() || error.message}`
						)
					);
				} else resolve(stdout);
			}
		);
		child.stdin?.on('error', () => {});
		child.stdin?.end(script);
	});
	const output = JSON.parse(stdout) as { result: string }[];
	const result = JSON.parse(output[0].result) as {
		columns: { name: string; type: string }[];
		rows: Record<string, unknown>[];
	};
	const columns = result.columns.map((column) => ({
		name: column.name,
		clickhouseType: column.type,
		jsType: getMotherduckToJsType(column.type)
	}));
	const rows = result.rows;
	normalizeDateRows(rows, new Set(columns.filter((c) => c.jsType === 'date').map((c) => c.name)));
	normalizeNumericRows(
		rows,
		new Set(columns.filter((c) => c.jsType === 'number').map((c) => c.name))
	);
	normalizeSparklineRows(rows, columns);
	return { rows, columns };
}
