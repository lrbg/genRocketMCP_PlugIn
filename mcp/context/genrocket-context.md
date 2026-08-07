# Contexto GenRocket MCP (para el agente)

Este servidor MCP expone GenRocket (datos sintéticos), un módulo de bases de datos
de solo lectura, generación local con el Runtime, un RAG de documentos y utilidades.
Lee esto ANTES de diagnosticar un problema o construir un flujo: evita errores
conocidos y te dice qué herramienta usar en cada caso.

## Cómo pensar los flujos

- **Explorar** antes de actuar: `genrocket_list_projects`, `genrocket_list_domains`,
  `genrocket_list_scenarios`, `genrocket_list_chains`.
- **Autoría**: crear dominio/atributos, asignar generadores, agregar receivers.
- **Generar datos**: se hace con el **Runtime local** (no por REST).
- **Consultar datos reales**: módulo de BD (JDBC solo lectura).

## API de GenRocket — cosas que SIEMPRE hay que recordar

- **Auth**: el tenant autentica con el header `x-auth-token`. `Authorization: Bearer`
  devuelve 401. El token viene en el body del login como `accessToken`. (Ya lo maneja
  el MCP; solo tenlo en mente al leer errores 401.)
- **`organizationId` es obligatorio** en casi todo. Si falta, configúralo.
- **Endpoints usan `/show`, no `/get`.**
- **Asignar un generador = borrar primero.** `POST /generator/add` sobre un atributo
  que YA tiene generador **cuelga y devuelve 500** (HTML). Hay que `deleteAll` antes.
  Las tools `genrocket_assign_generator` y `create_attribute_with_generator` ya lo hacen.
- **Nombres de generador**: salen del catálogo real de la organización
  (`genrocket_available_generators`); NO hay nombres genéricos garantizados (puede no
  existir `FirstNameGen`). Un nombre inválido → `Invalid Generator Name`.
- **Parámetros de un generador**: NO hay endpoint REST que los "describa". No los
  adivines (chocarás con `Invalid parameter name`/500). Usa
  **`genrocket_generator_parameters(domainId, attributeName)`** para ver los nombres y
  valores EXACTOS de los parámetros de los generadores ya asignados, y luego
  `genrocket_set_generator_parameter` con un nombre válido.
- **Crear una chain NO existe en la API.** No hay `/chain/create`. Armar una chain
  (elegir escenarios y su orden) solo se hace en el **GenRocket Designer web**. Una vez
  creada, se ejecuta con `genrocket_run_chain`. No intentes crear chains por REST.
- **No generar datos por REST.** Todos los `*/generate` dan 404; la generación es con
  el Runtime local.

## Runtime local (generar datos / chains)

- Requiere `GENROCKET_RUNTIME_CMD` configurado (usa `{grs}` y `{dir}`).
- **Java del Runtime = 8–11.** No compartas `JAVA_HOME` con el helper de BD; forzar un
  JDK nuevo al Runtime puede romper la lectura del perfil de licencia.
- **Licencia**: el Runtime lee `~/.genrocket/GR<id>Profile.grp` + `GR<id>Certificate.grc`.
  Si falta el certificado o el perfil es viejo/demo → "Unable to validate license /
  No User found for access Key". No se puede sobreescribir el access key por variables
  de entorno ni properties: hay que descargar perfil+certificado del portal web.
- **Conflictos de librerías**: `NoSuchMethodError` de Apache POI/xmlbeans al generar
  Excel = jars duplicados (dos versiones) en la carpeta `lib` del Runtime; hay que
  dejar una sola versión.
- Las tools del Runtime (`genrocket_run_chain`, `genrocket_run_scenario`, export/mask/
  subset) devuelven `stdout`/`stderr` y avisan si el exit ≠ 0: **lee esa salida** para
  ver la causa real (licencia, POI, etc.).
- **`genrocket_runtime_doctor`**: diagnostica de un tiro Java, Runtime, perfil/cert de
  licencia, jars POI duplicados y las conexiones de BD. Úsalo ante cualquier fallo del
  Runtime antes de investigar a mano.

## Base de datos (JDBC, SOLO LECTURA: Oracle + SQL Server)

- Conexiones en `genrocket.dbConnections`; la contraseña se pide segura al iniciar.
- **`driverJar`** puede ser el `.jar` del driver o la **carpeta** que lo contiene.
- Solo se permiten `SELECT`/`WITH`. Cualquier otra cosa se rechaza.
- Si una consulta falla, el MCP ahora propaga el **error real de Java** (driver no
  encontrado, versión, etc.), no un resultado vacío.
- **`db_explore(connection)`** analiza todo el esquema (tablas, columnas, PK, FK,
  índices) y **genera un `.md` de contexto por base de datos**. Ejecútalo una vez y
  luego usa ese contexto (o `db_read_context`) para construir consultas con criterio.
- Explora con `db_list_tables` / `db_describe_table` antes de escribir SQL complejo.

## Playbook de diagnóstico (síntoma → acción)

- **"(sin columnas)" o SQL sin datos** → revisa `driverJar` (debe apuntar al `.jar` o a
  su carpeta) y corre `genrocket_runtime_doctor`. El error real ya se propaga.
- **Chain/escenario falla (exit ≠ 0, 0 archivos)** → lee `stderr` de la tool; corre
  `genrocket_runtime_doctor` (licencia / POI / Java).
- **Corre bien (exit 0) pero genera 0 archivos** → al escenario le falta un RECEIVER
  en su dominio primario (el Designer avisa: "This Scenario does not have any Receivers
  assigned to its primary Scenario Domains. Running this Scenario will produce no
  output."). Para agregarlo: llama a `genrocket_available_receivers`, MUÉSTRALE al
  usuario los tipos (CSV, Excel, JSON, XML) y PREGÚNTALE cuál quiere; NO elijas tú.
  Luego `genrocket_add_domain_receiver` con el tipo elegido y `genrocket_set_receiver_parameter`
  para outputPath/fileName. En una chain, CADA escenario necesita su receiver.
- **"Invalid parameter name" al setear un generador** → `genrocket_generator_parameters`
  para ver los nombres válidos.
- **"Invalid Generator Name"** → `genrocket_available_generators` / `genrocket_suggest_generators`.
- **500 al asignar generador** → el atributo ya tenía generador; usa la tool que
  reemplaza (`genrocket_assign_generator`), que borra antes.
- **Necesitas una chain y no existe** → créala en el Designer web; no hay API.

## Reglas

- BD: **solo lectura**. Nunca ejecutes DML/DDL.
- No intentes **puentear la licencia** del Runtime (env vars, bytecode): usa el portal.
- No hagas **llamadas REST a ciegas** a endpoints no documentados contra un tenant
  productivo.
