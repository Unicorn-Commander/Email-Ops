import { Logger, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { CalDavPort } from './caldav.port';
import { CalDavClient } from './caldav.client';
import { CalendarController } from './calendar.controller';
import {
  CalendarCredentialsPort,
  UnavailableCalendarCredentials,
} from './calendar-credentials.port';
import { BridgeCalendarCredentials } from './bridge-calendar-credentials';
import { CalendarBridgeClient } from './calendar-bridge.client';
import { CalendarService } from './calendar.service';
import { CalendarDevicesController } from './calendar-devices.controller';
import { CalendarDevicesService } from './calendar-devices.service';

export function selectCalendarCredentialsProvider(
  bridge: Pick<CalendarBridgeClient, 'isConfigured'>,
  configured: CalendarCredentialsPort,
  unavailable: CalendarCredentialsPort,
  logger: Pick<Logger, 'log'> = new Logger('CalendarModule'),
): CalendarCredentialsPort {
  const provider = bridge.isConfigured() ? configured : unavailable;
  logger.log(
    `Calendar credentials provider: ${provider === configured ? 'bridge' : 'fail-closed'}`,
  );
  return provider;
}

@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [CalendarController, CalendarDevicesController],
  providers: [
    CalDavClient,
    { provide: CalDavPort, useExisting: CalDavClient },
    CalendarBridgeClient,
    BridgeCalendarCredentials,
    UnavailableCalendarCredentials,
    {
      provide: CalendarCredentialsPort,
      inject: [CalendarBridgeClient, BridgeCalendarCredentials, UnavailableCalendarCredentials],
      useFactory: (
        bridge: CalendarBridgeClient,
        configured: BridgeCalendarCredentials,
        unavailable: UnavailableCalendarCredentials,
      ) => selectCalendarCredentialsProvider(bridge, configured, unavailable),
    },
    CalendarService,
    CalendarDevicesService,
  ],
  exports: [
    CalendarService,
    CalendarDevicesService,
    CalDavPort,
    CalendarCredentialsPort,
    CalendarBridgeClient,
  ],
})
export class CalendarModule {}
