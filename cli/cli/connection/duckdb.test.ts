import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeQuery, listTablesSql } from './index';
import { loadConnectionConfig } from './load-config';
import { dialectFor } from '@evidence/core/sql-dialect';
import type { DuckDBConnectionConfig } from './types';

let cwd: string;
let config: DuckDBConnectionConfig;

beforeEach(async () => {
	cwd = await mkdtemp(path.join(tmpdir(), 'evidence-duckdb-'));
	config = {
		type: 'duckdb',
		cwd,
		database: ':memory:',
		executable: 'duckdb',
		sources: {},
		schemas: []
	};
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe('DuckDB configuration', () => {
	it('resolves database and executable paths and defaults source formats', async () => {
		await writeFile(
			path.join(cwd, 'connection.yaml'),
			'type: duckdb\ndatabase: ./data.db\nexecutable: ./bin/duckdb\nsources:\n  orders:\n    path: ./orders.parquet\n'
		);
		expect(await loadConnectionConfig(cwd)).toEqual({
			...config,
			database: path.join(cwd, 'data.db'),
			executable: path.join(cwd, 'bin/duckdb'),
			sources: { orders: { path: './orders.parquet', format: 'parquet' } }
		});
	});

	it('rejects empty path lists and unsupported formats', async () => {
		for (const source of ['path: []', 'path: data.xlsx\n    format: xlsx']) {
			await writeFile(
				path.join(cwd, 'connection.yaml'),
				`type: duckdb\nsources:\n  orders:\n    ${source}\n`
			);
			await expect(loadConnectionConfig(cwd)).rejects.toThrow(/connection.yaml: sources.orders/);
		}
	});

	it('selects DuckDB SQL for component queries', () => {
		const dialect = dialectFor('duckdb');
		expect(dialect.name).toBe('duckdb');
		expect(dialect.dateAdd('day', 7, 'date')).toBe('date + to_days(7)');
	});

	it('reports a missing server executable', async () => {
		await expect(
			executeQuery('SELECT 1', { ...config, executable: path.join(cwd, 'missing') })
		).rejects.toThrow('DuckDB executable not found');
	});
});

let hasDuckDB = false;
try {
	execFileSync('duckdb', ['--version']);
	hasDuckDB = true;
} catch {
	// Integration tests require the same executable as deployments using this connector.
}

describe.skipIf(!hasDuckDB)('DuckDB execution', () => {
	it('queries Parquet files and discovers source views', async () => {
		execFileSync(
			'duckdb',
			[
				'-batch',
				'-bail',
				'-c',
				"COPY (SELECT 1::BIGINT AS id, 12.50::DECIMAL(10,2) AS amount, DATE '2026-09-30' AS day, true AS active) TO 'orders.parquet' (FORMAT PARQUET)"
			],
			{ cwd }
		);
		config.sources = { orders: { path: './orders.parquet', format: 'parquet' } };
		const result = await executeQuery('SELECT * FROM orders;', config);
		expect(result.rows).toEqual([{ id: 1, amount: 12.5, day: '2026-09-30', active: true }]);
		expect(result.columns.map((c) => c.jsType)).toEqual(['number', 'number', 'date', 'boolean']);
		expect((await executeQuery(listTablesSql(config), config)).rows).toEqual([{ name: 'orders' }]);
		const columns = await executeQuery(
			"SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' ORDER BY ordinal_position",
			config
		);
		expect(columns.rows.map((r) => r.column_name)).toEqual(['id', 'amount', 'day', 'active']);
	});

	it('preserves metadata for empty results', async () => {
		const result = await executeQuery(
			"SELECT 1::INTEGER AS n, DATE '2026-09-30' AS day WHERE false",
			config
		);
		expect(result.rows).toEqual([]);
		expect(result.columns.map((c) => [c.name, c.jsType])).toEqual([
			['n', 'number'],
			['day', 'date']
		]);
	});

	it('accepts CTEs and trailing line comments', async () => {
		expect(
			(await executeQuery('WITH totals AS (SELECT 42 AS n) SELECT * FROM totals -- total', config))
				.rows
		).toEqual([{ n: 42 }]);
	});

	it('joins CSV and JSON sources with quoted names and paths', async () => {
		await writeFile(path.join(cwd, "customer's.csv"), 'id,name\n1,Alice\n');
		await writeFile(path.join(cwd, 'events.json'), '[{"id":1,"amount":42}]');
		config.sources = {
			'customer"data': { path: "./customer's.csv", format: 'csv' },
			events: { path: ['./events.json'], format: 'json' }
		};
		expect(
			(
				await executeQuery(
					'SELECT name, amount FROM "customer""data" JOIN events USING (id)',
					config
				)
			).rows
		).toEqual([{ name: 'Alice', amount: 42 }]);
	});

	it('queries an existing database read-only alongside temporary sources', async () => {
		config.database = path.join(cwd, 'analytics.duckdb');
		execFileSync('duckdb', [config.database, '-c', 'CREATE TABLE orders AS SELECT 42 AS amount']);
		await writeFile(path.join(cwd, 'customers.csv'), 'name\nAlice\n');
		config.sources = { customers: { path: './customers.csv', format: 'csv' } };
		expect(
			(await executeQuery('SELECT amount, name FROM orders CROSS JOIN customers', config)).rows
		).toEqual([{ amount: 42, name: 'Alice' }]);
	});

	it('normalises generated sparkline values and reports SQL errors', async () => {
		const dialect = dialectFor('duckdb');
		const result = await executeQuery(
			`SELECT ${dialect.groupArray('day', 'amount')} AS __ev_sparkline_test FROM (SELECT DATE '2026-09-30' AS day, 42 AS amount)`,
			config
		);
		expect(result.rows[0].__ev_sparkline_test).toEqual([['2026-09-30', 42]]);
		await expect(executeQuery('SELECT * FROM missing', config)).rejects.toThrow(
			/DuckDB query failed:.*Catalog Error/s
		);
	});
});
