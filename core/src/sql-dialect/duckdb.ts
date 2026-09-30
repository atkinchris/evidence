import { MotherDuckDialect } from './motherduck';

export class DuckDBDialect extends MotherDuckDialect {
	override readonly name = 'duckdb';
}
