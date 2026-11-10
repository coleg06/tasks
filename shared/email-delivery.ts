/** Workflow email policy shared by server and web clients. */
export type EmailFrequency = 'immediate' | 'hourly' | 'daily' | 'weekly' | 'off';
export type EmailDeliveryPreferences = {
  hardLimit: number;
  period: 'hour' | 'day' | 'week';
  assignments: EmailFrequency;
  comments: EmailFrequency;
  mentions: EmailFrequency;
  deadlines: EmailFrequency;
};
