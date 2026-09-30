import { z } from 'zod/v4';

export const duckdbBase = z.object({
	type: z.literal('duckdb'),
	database: z.string().min(1).default(':memory:'),
	executable: z.string().min(1).default('duckdb'),
	sources: z
		.record(
			z.string().min(1),
			z.object({
				path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
				format: z.enum(['parquet', 'csv', 'json']).default('parquet')
			})
		)
		.default({}),
	schemas: z.array(z.string().min(1)).default([])
});

export const duckdbConnectionSchema = duckdbBase;

export type DuckDBConnection = z.infer<typeof duckdbConnectionSchema>;
