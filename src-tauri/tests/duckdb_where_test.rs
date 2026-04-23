use duckdb::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

struct Engine {
    conn: Mutex<Connection>,
    sources: Mutex<HashMap<String, (String, String)>>,
}

impl Engine {
    fn new() -> Self {
        Self {
            conn: Mutex::new(Connection::open_in_memory().unwrap()),
            sources: Mutex::new(HashMap::new()),
        }
    }

    fn register(&self, name: &str, path: &str, format: &str) {
        self.sources.lock().unwrap().insert(
            name.to_string(),
            (path.to_string(), format.to_string()),
        );
    }

    fn wrap_query(&self, user_sql: &str) -> String {
        let sources = self.sources.lock().unwrap();
        if sources.is_empty() {
            return user_sql.to_string();
        }

        let mut cte_parts: Vec<String> = Vec::new();
        for (name, (path, format)) in sources.iter() {
            let read_fn = match format.as_str() {
                "parquet" => format!("read_parquet('{}')", path),
                "csv" => format!("read_csv('{}')", path),
                _ => panic!("unsupported"),
            };
            let escaped = name.replace('"', "\"\"");
            cte_parts.push(format!("\"{}\" AS (SELECT * FROM {})", escaped, read_fn));
        }
        let cte_block = cte_parts.join(", ");

        let trimmed = user_sql.trim_start();
        if trimmed.len() >= 4
            && trimmed[..4].eq_ignore_ascii_case("with")
            && trimmed.as_bytes().get(4).map_or(false, |b| b.is_ascii_whitespace())
        {
            format!("WITH {}, {}", cte_block, &trimmed[4..].trim_start())
        } else {
            format!("WITH {} {}", cte_block, user_sql)
        }
    }

    fn query_with_result(&self, user_sql: &str) -> Result<Vec<Vec<String>>, duckdb::Error> {
        let sql = self.wrap_query(user_sql);
        let conn = self.conn.lock().unwrap();

        // Mirror the app: execute_batch into a temp table, then read from it.
        // This bypasses the broken prepare() path for CTEs + WHERE.
        let temp_table = format!("__test_{}", rand_id());
        let create_sql = format!("CREATE TEMP TABLE \"{}\" AS {}", temp_table, sql);
        conn.execute_batch(&create_sql)?;

        let select_sql = format!("SELECT * FROM \"{}\"", temp_table);
        let mut stmt = conn.prepare(&select_sql)?;
        let mut result_rows = stmt.query([])?;

        let mut rows = Vec::new();
        let mut col_count = 0;
        while let Some(row) = result_rows.next()? {
            if col_count == 0 {
                col_count = row.as_ref().column_count();
            }
            let mut data = Vec::new();
            for i in 0..col_count {
                let val: duckdb::types::Value = row.get(i)?;
                data.push(format!("{:?}", val));
            }
            rows.push(data);
        }
        drop(result_rows);
        drop(stmt);

        let _ = conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{}\"", temp_table));
        Ok(rows)
    }
}

fn rand_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    format!("{}", t.as_nanos())
}

#[test]
fn test_cte_approach_with_where() {
    let tmp = Connection::open_in_memory().unwrap();
    tmp.execute_batch(
        "COPY (SELECT i AS id, 'row_' || i AS name FROM range(50) t(i)) \
         TO '/tmp/rs_graph_document_repository_link.parquet' (FORMAT PARQUET)"
    ).unwrap();

    let engine = Engine::new();
    engine.register(
        "rs_graph_document_repository_link",
        "/tmp/rs_graph_document_repository_link.parquet",
        "parquet"
    );

    // No WHERE
    let r1 = engine.query_with_result(
        "SELECT * FROM \"rs_graph_document_repository_link\" LIMIT 100"
    ).unwrap();
    assert_eq!(r1.len(), 50);

    // With WHERE — this was the failing case
    let r2 = engine.query_with_result(
        "SELECT * FROM \"rs_graph_document_repository_link\" WHERE id = 1 LIMIT 100"
    ).unwrap();
    assert_eq!(r2.len(), 1);

    // Without quotes
    let r3 = engine.query_with_result(
        "SELECT * FROM rs_graph_document_repository_link WHERE id = 1 LIMIT 100"
    ).unwrap();
    assert_eq!(r3.len(), 1);
}

#[test]
fn test_cte_sequential_where_queries() {
    let tmp = Connection::open_in_memory().unwrap();
    tmp.execute_batch(
        "COPY (SELECT i AS id, 'val' || i AS val FROM range(20) t(i)) \
         TO '/tmp/seq_test.parquet' (FORMAT PARQUET)"
    ).unwrap();

    let engine = Engine::new();
    engine.register("seq_test", "/tmp/seq_test.parquet", "parquet");

    for i in 0..5 {
        let sql = format!("SELECT * FROM seq_test WHERE id = {} LIMIT 100", i);
        let r = engine.query_with_result(&sql).unwrap();
        assert_eq!(r.len(), 1, "Query for id={} failed", i);
    }

    let r = engine.query_with_result("SELECT * FROM seq_test LIMIT 100").unwrap();
    assert_eq!(r.len(), 20);
}

#[test]
fn test_cte_with_csv() {
    std::fs::write("/tmp/test_cte.csv", "id,name\n1,alice\n2,bob\n3,charlie\n").unwrap();

    let engine = Engine::new();
    engine.register("test_cte", "/tmp/test_cte.csv", "csv");

    let r = engine.query_with_result("SELECT * FROM test_cte WHERE id = 2").unwrap();
    assert_eq!(r.len(), 1);
}

#[test]
fn test_cte_user_query_with_existing_with() {
    let tmp = Connection::open_in_memory().unwrap();
    tmp.execute_batch(
        "COPY (SELECT i AS id FROM range(10) t(i)) \
         TO '/tmp/test_with_cte.parquet' (FORMAT PARQUET)"
    ).unwrap();

    let engine = Engine::new();
    engine.register("test_with_cte", "/tmp/test_with_cte.parquet", "parquet");

    let r = engine.query_with_result(
        "WITH doubled AS (SELECT id, id*2 AS doubled_id FROM test_with_cte) \
         SELECT * FROM doubled WHERE id = 3"
    ).unwrap();
    assert_eq!(r.len(), 1);
}
