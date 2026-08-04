import java.sql.*;

/**
 * Ejecuta UNA consulta SELECT de solo lectura vía JDBC (ojdbc en el classpath)
 * y devuelve el resultado como JSON en stdout.
 *
 * Entrada:
 *   env DB_URL, DB_USER, DB_PASSWORD, DB_MAXROWS (opcional, default 500)
 *   SQL por stdin
 * Salida (stdout): {"columns":[...],"rows":[[...]],"rowCount":n} o {"error":"..."}
 *
 * Solo lectura: rechaza cualquier statement que no empiece con SELECT/WITH,
 * fija la conexión en read-only y toma solo el primer statement.
 */
public class DbQuery {
  public static void main(String[] args) {
    String url = System.getenv("DB_URL");
    String user = System.getenv("DB_USER");
    String pass = System.getenv("DB_PASSWORD");
    int maxRows = 500;
    try { maxRows = Integer.parseInt(System.getenv().getOrDefault("DB_MAXROWS", "500")); } catch (Exception ignore) {}

    try {
      String sql = readStdin().trim();
      String low = sql.toLowerCase();
      if (!(low.startsWith("select") || low.startsWith("with"))) {
        out("{\"error\":" + jsonStr("Solo se permiten consultas SELECT (modo solo lectura).") + "}");
        return;
      }
      int semi = sql.indexOf(';');
      if (semi >= 0) { sql = sql.substring(0, semi); } // un solo statement

      try { Class.forName("oracle.jdbc.OracleDriver"); } catch (Throwable ignore) { /* SPI puede registrarlo */ }

      try (Connection conn = DriverManager.getConnection(url, user, pass)) {
        try { conn.setReadOnly(true); } catch (Throwable ignore) {}
        try { conn.setAutoCommit(false); } catch (Throwable ignore) {}
        try (Statement st = conn.createStatement()) {
          st.setMaxRows(maxRows);
          try (ResultSet rs = st.executeQuery(sql)) {
            ResultSetMetaData md = rs.getMetaData();
            int n = md.getColumnCount();
            StringBuilder sb = new StringBuilder();
            sb.append("{\"columns\":[");
            for (int i = 1; i <= n; i++) { if (i > 1) sb.append(','); sb.append(jsonStr(md.getColumnLabel(i))); }
            sb.append("],\"rows\":[");
            int r = 0;
            while (rs.next()) {
              if (r > 0) sb.append(',');
              sb.append('[');
              for (int i = 1; i <= n; i++) { if (i > 1) sb.append(','); sb.append(jsonVal(rs.getObject(i))); }
              sb.append(']');
              r++;
            }
            sb.append("],\"rowCount\":").append(r).append('}');
            out(sb.toString());
          }
        }
      }
    } catch (Throwable e) {
      String m = e.getMessage() == null ? e.toString() : e.getMessage();
      out("{\"error\":" + jsonStr(m) + "}");
    }
  }

  static void out(String s) { System.out.print(s); System.out.flush(); }

  static String readStdin() throws Exception {
    StringBuilder s = new StringBuilder();
    java.io.Reader r = new java.io.InputStreamReader(System.in, "UTF-8");
    int c; while ((c = r.read()) != -1) s.append((char) c);
    return s.toString();
  }

  static String jsonStr(String s) {
    if (s == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    for (char c : s.toCharArray()) {
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
      }
    }
    b.append('"');
    return b.toString();
  }

  static String jsonVal(Object v) {
    if (v == null) return "null";
    if (v instanceof Number || v instanceof Boolean) return v.toString();
    return jsonStr(v.toString());
  }
}
