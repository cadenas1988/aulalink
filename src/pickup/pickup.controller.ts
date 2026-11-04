import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Observable, distinctUntilChanged, interval, map, switchMap } from 'rxjs';
import { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { N8nSignatureGuard } from '../integrations/n8n-signature.guard';
import { CreatePickupRequestDto } from './create-pickup-request.dto';
import { detectImageMime } from './image-validation';
import { PickupService } from './pickup.service';

const STAFF_ROLES = ['administrator', 'direction', 'security', 'prefect', 'teacher'];
const ALLOWED_PHOTO_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

@ApiTags('pickup-requests')
@Controller()
export class PickupController {
  constructor(private readonly pickup: PickupService) {}

  @Post('pickup-requests')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('security', 'prefect', 'teacher')
  @UseInterceptors(
    FileInterceptor('photo', {
      limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1,
        fields: 1,
        parts: 2,
        fieldSize: 16 * 1024,
      },
    }),
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear una solicitud de autorización de recogida' })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['request', 'photo'],
      properties: {
        request: {
          type: 'object',
          description: 'JSON con studentId y pickupPerson.',
          properties: {
            studentId: { type: 'string', format: 'uuid' },
            pickupPerson: {
              type: 'object',
              properties: {
                fullName: { type: 'string', maxLength: 200 },
                relationshipToStudent: { type: 'string', maxLength: 100 },
              },
            },
          },
        },
        photo: { type: 'string', format: 'binary' },
      },
    },
    encoding: { request: { contentType: 'application/json' } },
  })
  @ApiCreatedResponse({ description: 'Solicitud registrada en estado pendiente.' })
  @ApiUnauthorizedResponse({ description: 'Autenticación inválida o ausente.' })
  async create(
    @Req() request: AuthenticatedRequest,
    @Body('request') requestJson: unknown,
    @UploadedFile() photo: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!request.user) throw new BadRequestException('Identidad del usuario ausente.');
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 16 ||
      idempotencyKey.length > 200
    ) {
      throw new BadRequestException('Idempotency-Key inválida.');
    }
    if (!photo?.buffer?.length) {
      throw new BadRequestException('La fotografía es obligatoria.');
    }

    let parsed: unknown;
    try {
      parsed =
        typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;
    } catch {
      throw new BadRequestException('El campo request debe contener JSON válido.');
    }
    const dto = this.validateCreateDto(parsed);
    const detected = detectImageMime(photo.buffer);
    if (
      !detected ||
      !ALLOWED_PHOTO_TYPES.has(detected) ||
      photo.mimetype !== detected
    ) {
      throw new BadRequestException(
        'Fotografía no permitida; use JPEG, PNG o WebP válido.',
      );
    }

    return this.pickup.create(dto, request.user.sub, idempotencyKey, {
      buffer: photo.buffer,
      mimeType: detected,
    });
  }

  @Get('pickup-requests/:requestId')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Consultar el estado de una solicitud' })
  @ApiOkResponse({ description: 'Estado y versión actuales de la solicitud.' })
  async get(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ): Promise<Record<string, unknown>> {
    return this.pickup.get(requestId);
  }

  @Post('pickup-requests/:requestId/cancel')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...STAFF_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cancelar una solicitud pendiente como personal escolar',
  })
  @ApiOkResponse({
    description:
      'Solicitud cancelada; una respuesta posterior del tutor no podrá autorizarla.',
  })
  async cancel(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    if (!request.user) throw new BadRequestException('Identidad del usuario ausente.');
    return this.pickup.cancel(requestId, request.user.sub);
  }

  @Sse('pickup-requests/:requestId/events')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(...STAFF_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Transmitir actualizaciones de estado mediante Server-Sent Events',
  })
  events(
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
  ): Observable<{ id: string; type: string; data: Record<string, unknown> }> {
    return interval(1000).pipe(
      switchMap(() => this.pickup.get(requestId)),
      distinctUntilChanged(
        (previous, current) =>
          previous.stateVersion === current.stateVersion,
      ),
      map((data) => ({
        id: String(data.stateVersion),
        type: 'pickup-request.updated',
        data,
      })),
    );
  }

  @Post('integrations/n8n/pickup-events')
  @UseGuards(N8nSignatureGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Procesar confirmaciones y resultados de WhatsApp enviados por n8n',
  })
  @ApiHeader({ name: 'X-Webhook-Timestamp', required: true })
  @ApiHeader({ name: 'X-Webhook-Signature', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async n8nEvent(
    @Body() event: Record<string, unknown>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<{ eventId: string; disposition: string }> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 16) {
      throw new BadRequestException('Idempotency-Key inválida.');
    }
    return this.pickup.recordN8nEvent(event, idempotencyKey);
  }

  private validateCreateDto(value: unknown): CreatePickupRequestDto {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !['studentId', 'pickupPerson'].includes(key),
      )
    ) {
      throw new BadRequestException('Los campos de solicitud no son válidos.');
    }
    const dto = value as Record<string, unknown>;
    if (
      typeof dto.studentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        dto.studentId,
      ) ||
      !dto.pickupPerson ||
      typeof dto.pickupPerson !== 'object' ||
      Array.isArray(dto.pickupPerson) ||
      Object.keys(dto.pickupPerson).some(
        (key) => !['fullName', 'relationshipToStudent'].includes(key),
      ) ||
      typeof (dto.pickupPerson as Record<string, unknown>).fullName !== 'string' ||
      ((dto.pickupPerson as Record<string, string>).fullName).trim().length < 1 ||
      ((dto.pickupPerson as Record<string, string>).fullName).trim().length > 200 ||
      typeof (dto.pickupPerson as Record<string, unknown>).relationshipToStudent !==
        'string' ||
      ((dto.pickupPerson as Record<string, string>).relationshipToStudent).trim()
        .length < 1 ||
      ((dto.pickupPerson as Record<string, string>).relationshipToStudent).trim()
        .length > 100
    ) {
      throw new BadRequestException('Los campos de solicitud no son válidos.');
    }
    return dto as unknown as CreatePickupRequestDto;
  }
}
