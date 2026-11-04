import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePickupRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  studentId!: string;

  @ApiProperty({
    type: 'object',
    required: ['fullName', 'relationshipToStudent'],
    properties: {
      fullName: { type: 'string', maxLength: 200 },
      relationshipToStudent: { type: 'string', maxLength: 100 },
    },
  })
  @ValidateNested()
  @Type(() => PickupPersonDto)
  pickupPerson!: PickupPersonDto;
}

export class PickupPersonDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @Length(1, 200)
  fullName!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @Length(1, 100)
  relationshipToStudent!: string;
}

export class PickupRequestResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  studentId!: string;

  @ApiProperty()
  pickupPerson!: {
    fullName: string;
    relationshipToStudent: string;
  };

  @ApiProperty({
    enum: ['pending', 'authorized', 'rejected', 'cancelled'],
  })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  escalationDueAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  decidedAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  cancelledAt!: string | null;

  @ApiProperty()
  stateVersion!: number;
}
