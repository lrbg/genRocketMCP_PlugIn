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
- **Genera pocos/1 registro (o quieres N filas)** → es el `loopCount` del dominio.
  NO necesitas el Designer: al correr pasa `records` + `domain` (o `loops`) a
  `genrocket_run_scenario`/`genrocket_run_chain`; el plugin escribe un archivo `-apif`
  con `domainSetLoopCount` y overridea el conteo en tiempo de corrida. Ej.: para 50
  agentes, records=50 domain=Agente. Si el dominio primario depende de otro (parent),
  sube también el conteo del padre con `loops` (ej. { "Agente": 50, "Asegurado": 50 }).
- **El escenario creado por el AGENTE no corre pero el MANUAL sí** → el .grs viene
  CIFRADO, así que NO lo diagnostiques por diff de archivo. Corre `genrocket_show_scenario`
  en AMBOS y compara la ESTRUCTURA. Revisa, en este orden: (1) el dominio primario está
  marcado `primary: true`; (2) ese dominio primario tiene un RECEIVER ligado; (3) DEPENDENCIAS
  de dominio: si el dominio primario tiene `parent` (ej. Agente cuyo parent es Asegurado, con
  un `ReferenceGen`→`Asegurado.id`), el escenario DEBE incluir TAMBIÉN el dominio padre —
  un create de un solo dominio rompe la referencia y no genera bien. El `create_scenario`
  por REST hace un escenario mínimo (un dominio, sin primary/receiver/parent), por eso falla.
  RECOMENDACIÓN: en vez de crear uno nuevo desde cero, **CLONA** un escenario que ya funciona
  (botón Copy en el Designer, por las manos web): así hereda dominios, primary, parent y receivers.
  Diferencias que son POR DISEÑO (no fallas): en un chain se usa `ExcelFileMultiSheetReceiver`
  a un workbook compartido, `loopCount` alto y la columna `id` excluida (solo para relacionar
  internamente); standalone usa `ExcelFileReceiver` a archivo propio, loopCount 1 e `id` incluida.

## Manos web (Playwright) — para lo que la API REST NO puede

Si está activo el servidor **Playwright (GenRocket web)** (comando "GenRocket: Activar
automatización web"), tienes herramientas de navegador (browser_navigate, browser_snapshot,
browser_click, browser_type, etc.) que se adjuntan al **Edge que el usuario YA tiene abierto
y logueado** en el Designer (`app.genrocket.com`). Úsalas SOLO para lo que REST no permite.
Reglas de oro:
- **Usa las herramientas del servidor "Playwright (GenRocket web)"** (se llaman `browser_navigate`,
  `browser_snapshot`, `browser_click`, `browser_type`, …). **NO uses** las herramientas de navegador
  genéricas del editor (`open_browser_page`, `navigate_page`, `read_page`, `screenshot_page`,
  `click_element`, etc.): esas abren un navegador NUEVO/limpio que la política de dispositivo bloquea.
  Si SOLO ves esas genéricas y no las `browser_*`, el servidor Playwright no está activo: dile al
  usuario que ejecute "GenRocket: Activar automatización web" y reinicie los MCP. No sigas con las genéricas.
- **NO abras una ventana/pestaña nueva ni un contexto limpio**: usa la pestaña ya abierta del
  Designer. Una sesión nueva es bloqueada por la política de dispositivo de la empresa
  ("You can't get there from here… only from domain joined devices"); solo la sesión ya
  autenticada del usuario pasa. Si te aparece un login de Microsoft, NO intentes iniciar
  sesión (no manejes credenciales corporativas): significa que no estás en la pestaña
  correcta — usa la que el usuario ya tiene abierta o pídele que la enfoque.
- **Lee la página antes de actuar** (browser_snapshot) y haz clic por lo que ves; no asumas selectores.
- Confirma con el usuario antes de guardar/crear algo irreversible.

Flujos del Designer:
- **Ligar el receiver al dominio primario del escenario** (causa típica de "0 archivos"
  aunque el dominio ya tenga receiver): abre el proyecto/versión → abre el **escenario**
  → sección **Scenario Domains** → selecciona el dominio **Primary** → asígnale el
  receiver ahí (no basta con tenerlo a nivel dominio) → **Save**.
- **Crear un escenario**: proyecto/versión → dominio → **Create Scenario** → nombre → Save.
  (También existe `genrocket_create_scenario` por REST; si falla, usa la web y revisa
  `genrocket_read_log` para el error REST.)
- **Crear/armar una chain**: sección **Chains** → **New Chain** → arrastra los escenarios
  en orden → Save. Luego se ejecuta con `genrocket_run_chain`.

## Reglas

- BD: **solo lectura**. Nunca ejecutes DML/DDL.
- No intentes **puentear la licencia** del Runtime (env vars, bytecode): usa el portal.
- No hagas **llamadas REST a ciegas** a endpoints no documentados contra un tenant
  productivo.
