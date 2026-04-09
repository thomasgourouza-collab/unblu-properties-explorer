import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import Aura from '@primeuix/themes/aura';
import { definePreset } from '@primeuix/themes';
import { MessageService } from 'primeng/api';
import { providePrimeNG } from 'primeng/config';

/** Aura defaults to emerald primary; use blue so Select / MultiSelect / overlay checkboxes match the app. */
const appAuraPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{blue.50}',
      100: '{blue.100}',
      200: '{blue.200}',
      300: '{blue.300}',
      400: '{blue.400}',
      500: '{blue.500}',
      600: '{blue.600}',
      700: '{blue.700}',
      800: '{blue.800}',
      900: '{blue.900}',
      950: '{blue.950}'
    }
  }
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAnimationsAsync(),
    MessageService,
    providePrimeNG({
      theme: {
        preset: appAuraPreset
      }
    })
  ]
};
