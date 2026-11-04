# AulaLink - Autorización de recogida

API NestJS/PostgreSQL para registrar solicitudes, enviar eventos confiables a n8n y aplicar autorizaciones confirmadas por WhatsApp.

> El panel web de presentación está en [`web/`](./web/README.md). Por ahora es una demostración con datos ficticios; no tiene autenticación ni conexión con la API y no debe usarse con datos reales.

## Requisitos

- Node.js 20 o posterior.
- PostgreSQL 13 o posterior con TLS en entornos compartidos.
- Almacenamiento privado compatible con S3, HTTPS y cifrado en reposo.
- Emisor institucional de JWT HS256 con `sub` UUID, `roles`, `iss`, `aud` y `exp`.
- n8n, una cuenta WhatsApp Business Cloud API y plantilla aprobada.

## Inicio local

1. Copiar `.env.example` a `.env` y sustituir todos los valores de ejemplo por secretos aleatorios. `PHONE_ENCRYPTION_KEY` y `PHONE_LOOKUP_KEY` deben ser claves base64 de 32 bytes; no reutilizar la misma clave.
2. Instalar paquetes con `npm install`.
3. Crear la base indicada por `DATABASE_URL` y aplicar `npm run migration:run`.
4. Poblar `school_students`, `school_contacts` y `school_student_contacts` desde un proceso confiable de sincronización del padrón. Asignar `primary`, `secondary` o `registered_pickup`; cifrar teléfonos con AES-256-GCM y generar su índice HMAC con `SensitiveDataService`; no insertarlos en claro.
5. Configurar el bucket S3 privado, n8n y los secretos de ambos sentidos.
6. Ejecutar `npm run start:dev`; la documentación Swagger queda en `/api/docs`.

El proyecto no crea usuarios, no emite JWT, no administra el padrón escolar y no incluye credenciales de Meta. Esos sistemas deben integrarse mediante el proveedor institucional de identidad y el proceso autorizado de sincronización de alumnos/tutores.

## Contrato y rutas

- Especificación: [`docs/openapi.yaml`](./docs/openapi.yaml).
- Integración WhatsApp/n8n y payloads: [`docs/integrations.md`](./docs/integrations.md).
- Migración PostgreSQL: [`db/migrations/001_pickup_authorization.sql`](./db/migrations/001_pickup_authorization.sql).
- `POST /api/v1/pickup-requests`: roles `security`, `prefect`, `teacher`; multipart con parte JSON `request` (`studentId`, `pickupPerson`) y fotografía JPEG/PNG/WebP (5 MiB máximo).
- `GET /api/v1/pickup-requests/{id}` y `/events`: personal institucional autenticado.
- `POST /api/v1/pickup-requests/{id}/cancel`: personal institucional autenticado; solo cancela solicitudes pendientes.
- `POST /api/v1/integrations/n8n/pickup-events`: callback HMAC de n8n.

La decisión del tutor principal es la única que autoriza/rechaza; una notificación al tutor secundario es escalamiento, no permiso implícito para entregar al alumno. El estado permanece pendiente hasta una decisión válida. Una respuesta tardía se audita y no altera un estado ya terminal.

## Seguridad operativa

- El JWT se verifica localmente con HS256, emisor, audiencia, expiración, UUID del sujeto y roles. El proveedor de identidad debe usar una clave compartida segura y rotarla coordinadamente.
- Todos los teléfonos y tokens de decisión se cifran a nivel de aplicación; el token de WhatsApp no se guarda en claro.
- Las fotos usan claves aleatorias en un bucket privado, URL GET firmada de cinco minutos y cifrado S3 AES256. Restringir el bucket a acceso de la aplicación y habilitar TLS.
- Usar HTTPS detrás de un proxy confiable, PostgreSQL TLS (`DATABASE_SSL=true`), CORS de origen explícito, gestor de secretos y respaldos cifrados.
- No habilitar logs de cuerpos HTTP ni capturas de formularios con datos reales. Aplicar retención/eliminación y revisar requisitos mexicanos de privacidad de menores antes del despliegue.
- `pickup_request_events` es append-only para el rol público, pero el propietario/admin de PostgreSQL puede alterarla. El despliegue debe usar un rol de aplicación sin `UPDATE`/`DELETE` sobre auditoría y respaldos inmutables.
- El límite HTTP global es 600 solicitudes por minuto por IP. Configurar correctamente el proxy de confianza antes de exponer la API; para varias réplicas, usar almacenamiento distribuido de rate-limit.

## Comprobaciones

```powershell
npm run build
npm test
```

Las pruebas unitarias actuales cubren firmas HMAC, rechazo de replay y cifrado autenticado. La prueba E2E e integración PostgreSQL/S3/n8n debe ejecutarse al proporcionar servicios de prueba; no usar datos reales de alumnos.
