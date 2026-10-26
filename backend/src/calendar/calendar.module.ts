import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { CalDavPort } from './caldav.port';
import { CalDavClient } from './caldav.client';
import { CalendarController } from './calendar.controller';
import { CalendarCredentialsPort, UnavailableCalendarCredentials } from './calendar-credentials.port';
import { CalendarService } from './calendar.service';

@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [CalendarController],
  providers: [
    CalDavClient,
    { provide: CalDavPort, useExisting: CalDavClient },
    UnavailableCalendarCredentials,
    { provide: CalendarCredentialsPort, useExisting: UnavailableCalendarCredentials },
    CalendarService,
  ],
  exports: [CalendarService, CalDavPort, CalendarCredentialsPort],
})
export class CalendarModule {}
