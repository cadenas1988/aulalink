# Integración n8n y WhatsApp Cloud API

## Flujo y responsabilidades

1. NestJS guarda la solicitud, los destinatarios cifrados, la auditoría y un evento `pickup.authorization.requested` en una sola transacción.
2. El despachador del outbox envía el evento a `N8N_WEBHOOK_URL` con HMAC `N8N_OUTBOUND_SECRET`. Los reintentos conservan el mismo `eventId`; n8n debe deduplicar por `Idempotency-Key` antes de enviar.
3. n8n envía la plantilla de WhatsApp al tutor principal y reporta `whatsapp.outbound.accepted` con el `wamid`. La ventana de escalamiento de cinco minutos empieza cuando NestJS registra la aceptación de Meta; si el envío falla, el escalamiento se agenda de inmediato.
4. Meta publica respuestas y estados al webhook de n8n. n8n valida la firma `X-Hub-Signature-256` de Meta y envía a NestJS un evento normalizado, firmado con `N8N_CALLBACK_SECRET`.
5. NestJS valida token de decisión, teléfono principal, mensaje contextual, estado pendiente e idempotencia antes de cambiar el estado.
6. Al vencer los cinco minutos sin decisión, el outbox publica `pickup.escalation.requested`; n8n envía una alerta al tutor secundario, a los contactos activos registrados para recoger y un correo a `ESCALATION_EMAIL_RECIPIENT`, y reporta el resultado. Esos contactos alternativos no reciben el token ni pueden autorizar o rechazar.

El outbox reintenta fallos con retroceso exponencial. La falta de respuesta nunca caduca ni autoriza la solicitud: permanece `pending` hasta decisión del tutor principal o cancelación explícita de personal mediante `POST /pickup-requests/{requestId}/cancel`. Si la solicitud ya fue decidida o cancelada al consumir el evento de escalamiento, n8n debe tratar `cancelled: true` como no-op.

## Firma entre servicios

Cabeceras:

```text
X-Webhook-Timestamp: <Unix time en segundos>
X-Webhook-Signature: v1=<hex HMAC-SHA256(timestamp + "\n" + cuerpo HTTP crudo)>
Idempotency-Key: <eventId>
```

Los secretos de salida y callback son distintos. NestJS limita callbacks a una ventana configurable (`WEBHOOK_MAX_AGE_SECONDS`, 300 por defecto) y exige que `Idempotency-Key` coincida con `eventId`. n8n debe conservar bytes/cuerpo del evento al verificar la firma y autenticar por separado cada lado.

## Plantilla WhatsApp

Crear y obtener aprobación en Meta para una plantilla de utilidad en `es_MX`, con encabezado de imagen y dos botones de respuesta rápida. Texto sugerido:

> La escuela solicita autorización para que **{{2}} ({{3}})** recoja a **{{1}}**. ¿Autoriza la entrega?

Ejemplo para `POST /{PHONE_NUMBER_ID}/messages` (token de Graph API gestionado en credenciales seguras de n8n):

```json
{
  "messaging_product": "whatsapp",
  "to": "+5215550000000",
  "type": "template",
  "template": {
    "name": "solicitud_autorizacion_recogida",
    "language": { "code": "es_MX" },
    "components": [
      {
        "type": "header",
        "parameters": [
          {
            "type": "image",
            "image": { "link": "URL temporal recibida en el evento" }
          }
        ]
      },
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Nombre del alumno" },
          { "type": "text", "text": "Nombre de quien recoge" },
          { "type": "text", "text": "Relación con el alumno" }
        ]
      },
      {
        "type": "button",
        "sub_type": "quick_reply",
        "index": "0",
        "parameters": [
          { "type": "payload", "payload": "authorize.<token-opaco>" }
        ]
      },
      {
        "type": "button",
        "sub_type": "quick_reply",
        "index": "1",
        "parameters": [
          { "type": "payload", "payload": "reject.<token-opaco>" }
        ]
      }
    ]
  }
}
```

Meta debe poder descargar la fotografía antes de que venza la URL firmada. No registrar URL firmada, teléfono, token, cuerpo completo de WhatsApp ni credenciales en logs. La aprobación de plantilla, disponibilidad del encabezado/botones y entrega en menos de diez segundos dependen de Meta; solo el despacho del servidor se controla directamente.

Como el envío a Meta y el registro en n8n no comparten una transacción, existe una pequeña ventana donde Meta puede aceptar un mensaje y n8n no alcanzar a guardar el `wamid`; en ese caso un reintento podría duplicar la notificación. La API usa outbox at-least-once, no promete exactly-once frente a un proveedor externo.

## Respuestas normalizadas

Decisión:

```json
{
  "eventId": "a9d2f208-2eb8-4fd9-98c9-d3978d827c04",
  "eventType": "pickup.decision.received",
  "schemaVersion": 1,
  "requestId": "8c8f2608-38eb-42b9-a5b9-4adfeb375c7c",
  "occurredAt": "2026-11-03T05:30:15Z",
  "decision": "authorize",
  "responderPhone": "+5215550000000",
  "incomingMessageId": "wamid.inbound",
  "contextMessageId": "wamid.outbound",
  "buttonId": "authorize.<token-opaco>"
}
```

La decisión debe mapearse desde el `button.payload` verificado por Meta, no desde el texto visible. Una respuesta ambigua debe recibir un mensaje breve indicando que solo se aceptan los botones **Autorizar** o **Rechazar**. Si no puede procesarse la respuesta, no reportar autorización; indicar que la escuela debe confirmar por el canal institucional.

Texto sugerido para respuesta ambigua: “Para responder, selecciona Autorizar o Rechazar en los botones de la solicitud. La autorización sigue pendiente.” Contingencia de integración: “No pudimos registrar tu respuesta. No se realizará la entrega con esta respuesta; comunícate con la escuela para confirmar.”

Escalamiento:

```json
{
  "eventType": "pickup.escalation.requested",
  "requestId": "8c8f2608-38eb-42b9-a5b9-4adfeb375c7c",
  "secondaryRecipient": { "phoneE164": "+5215550000001" },
  "registeredPickupRecipients": [{ "phoneE164": "+5215550000002" }],
  "emailRecipient": "school-office@example.edu"
}
```

El payload real incorpora `eventId`, `schemaVersion`, `occurredAt`, nombre del alumno y persona que recoge. `registeredPickupRecipients` incluye exclusivamente contactos activos registrados y su teléfono; no incluye tokens de decisión. El correo se envía al destinatario institucional configurado, no a una dirección obtenida del mensaje.
