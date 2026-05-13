import type { JukeboxStoredSettings } from '../models/jukebox-settings';
import { JukeboxSettings } from '../models/jukebox-settings';

export class SettingsService {
    private static readonly settingId: string = 'jukebox:settings';

    public static get settings(): JukeboxSettings {
        return JukeboxSettings.fromPartial(SettingsService.storedSettings);
    }

    public static set settings(settings: JukeboxSettings) {
        SettingsService.storedSettings = settings.toPartial();
    }

    public static get storedSettings(): JukeboxStoredSettings {
        const storageValue = Spicetify.LocalStorage.get(this.settingId);

        if (storageValue == null) {
            return new JukeboxSettings().toPartial();
        }

        const parsedValue: Partial<JukeboxStoredSettings> =
            JSON.parse(storageValue);
        return JukeboxSettings.fromPartial(parsedValue).toPartial();
    }

    public static set storedSettings(settings: JukeboxStoredSettings) {
        Spicetify.LocalStorage.set(this.settingId, JSON.stringify(settings));
    }
}
