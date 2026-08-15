import { AbstractControl } from '@angular/forms';

export class Utils {
  public static getRandomItem<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
  }

  public static shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  public static escapeCsvField(field: string | number): string {
    const fieldAsString = field.toString();
    if (fieldAsString.includes(',') || fieldAsString.includes('"') || fieldAsString.includes('\n')) {
      return `"${fieldAsString.replace(/"/g, '""')}"`;
    }
    return fieldAsString;
  }

  // Helper: add error without overwriting others
  public static addError(control: AbstractControl, errorKey: string) {
    const current = control.errors ?? {};
    if (!current[errorKey]) {
      control.setErrors({...current, [errorKey]: true});
    }
  };

  // Helper: remove only specific errorKey
  public static removeError(control: AbstractControl, errorKey: string) {
    const current = control.errors;
    if (current && current[errorKey]) {
      delete current[errorKey];
      // If no errors remain → null, otherwise preserve others
      control.setErrors(Object.keys(current).length ? current : null);
    }
  };
}
