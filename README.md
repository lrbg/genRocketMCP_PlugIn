# GenRocket MCP — Extensión de VS Code

Lleva GenRocket a VS Code: **explorador** de proyectos/escenarios/chains/dominios/generadores, **descarga** de escenarios `.grs`, **ejecución del Runtime** para generar datos, y un **servidor MCP** que expone todo como herramientas para el chat de IA (GitHub Copilot Chat).

Reúne en una sola extensión lo que antes vivía disperso: **configuración + tools + MCP + runtime**.

## Características

- **Explorador GenRocket** (barra lateral): proyectos → versión → Escenarios / Chains / Dominios → atributos → generadores.
- **Descargar escenario (.grs)** desde el explorador (para el Runtime).
- **Generar datos con el Runtime**: descarga el `.grs` y ejecuta tu GenRocket Runtime local; los archivos generados quedan en la carpeta de salida.
- **Plantilla CSV** por dominio (columnas = atributos) para carga masiva.
- **Servidor MCP**: registra las herramientas de GenRocket en Copilot Chat para conversar en lenguaje natural (test conexión, listar proyectos/escenarios/chains/dominios/generadores, descargar, ejecutar Runtime).
- **Credenciales seguras**: la contraseña se guarda en el **SecretStorage** de VS Code (no en texto plano). El MCP la pide con un input seguro.

## Requisitos

- VS Code ^1.96
- Node.js 20+
- Java (para el GenRocket Runtime) y el **GenRocket Runtime engine** instalado (software propietario de GenRocket) si vas a generar datos.

## Instalación (desde el código)

```bash
npm install            # dependencias de la extensión
npm run compile        # compila TypeScript a ./out
(cd mcp && npm install) # dependencias del servidor MCP
```

Luego abre la carpeta en VS Code y pulsa **F5** (Extension Development Host), o empaqueta:

```bash
npm run package        # genera el .vsix (requiere @vscode/vsce)
```

## Configuración

Cada usuario configura **sus propios datos**. La forma más clara es la **ventana de configuración**: comando **`GenRocket: Abrir configuración`** (o el ícono de engrane en el panel del explorador). Ahí pones tenant, usuario, contraseña, org id y el comando del Runtime, con botones para **probar conexión** y **registrar el MCP**.

- La **contraseña** se guarda cifrada en el **SecretStorage** de VS Code — nunca en el repositorio ni en texto plano.
- El **chat de IA** usa **tu propia suscripción de GitHub Copilot**; la extensión no guarda tokens de Copilot ni de OpenAI.
- Nada viene precargado con datos de otra organización: los valores por defecto son genéricos y **editables** por el usuario.

También puedes editar todo desde `Settings → GenRocket MCP`:

| Ajuste | Descripción |
|---|---|
| `genrocket.baseUrl` | Host/tenant de tu organización, ej. `https://TU-ORG.genrocket.com` |
| `genrocket.username` | Usuario (email) |
| `genrocket.organizationId` | Organization external ID |
| `genrocket.runtimeCommand` | Comando del Runtime, con `{grs}` y `{dir}`. Ej: `java -jar /ruta/GenRocketRuntime.jar {grs}` |
| `genrocket.runtimeOutputDir` | Carpeta de salida del Runtime (vacío = temporal) |

La **contraseña** se guarda con el comando **`GenRocket: Set Password`** (Command Palette).

## Usar el chat de IA (MCP)

1. Ejecuta el comando **`GenRocket: Registrar servidor MCP (Copilot Chat)`**. Escribe `.vscode/mcp.json` con la config y un input seguro para la contraseña.
2. Abre `.vscode/mcp.json` y pulsa **Start** en el servidor `genrocket`.
3. En Copilot Chat pídele, por ejemplo: *"lista los dominios del proyecto UST_LOB_POC v2.0"* o *"genera datos del escenario X con el Runtime"*.

## Herramientas MCP

`genrocket_test_connection`, `genrocket_list_scenarios`, `genrocket_list_chains`, `genrocket_list_domains`, `genrocket_list_generators`, `genrocket_download_scenario`, `genrocket_runtime_status`, `genrocket_run_scenario`.

## Notas sobre GenRocket

- La **autoría** (crear dominios, atributos, generadores, receivers, diseñar escenarios) se hace en el **GenRocket Designer**; la REST API es de lectura/consumo.
- La **generación de datos** la realiza el **GenRocket Runtime** con la definición `.grs`; la nube no genera ni devuelve datos por REST.

## Licencia

MIT
