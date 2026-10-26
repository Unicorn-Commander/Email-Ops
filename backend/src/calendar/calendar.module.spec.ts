import { CalendarCredentialsPort, UnavailableCalendarCredentials } from './calendar-credentials.port';
import { selectCalendarCredentialsProvider } from './calendar.module';
import { CalendarBridgeClient } from './calendar-bridge.client';

describe('CalendarModule credential provider selection', () => {
  it('logs only the selected provider name for bridge and fail-closed modes', () => {
    const configured = {} as CalendarCredentialsPort;
    const unavailable = new UnavailableCalendarCredentials();
    const logger = { log: jest.fn() };

    expect(
      selectCalendarCredentialsProvider(
        { isConfigured: () => true } as CalendarBridgeClient,
        configured,
        unavailable,
        logger,
      ),
    ).toBe(configured);
    expect(logger.log).toHaveBeenLastCalledWith('Calendar credentials provider: bridge');

    expect(
      selectCalendarCredentialsProvider(
        { isConfigured: () => false } as CalendarBridgeClient,
        configured,
        unavailable,
        logger,
      ),
    ).toBe(unavailable);
    expect(logger.log).toHaveBeenLastCalledWith('Calendar credentials provider: fail-closed');
    expect(logger.log).toHaveBeenCalledTimes(2);
  });
});
