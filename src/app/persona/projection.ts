import {
  MATRIX_UNSTABLE_COLORS,
  MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME,
} from '$unstable/prefixes';
import type { PerMessageProfileBeeperFormat, Persona } from './index';

export function convertPerMessageProfileToBeeperFormat(
  profile: Persona,
  has_fallback: boolean
): PerMessageProfileBeeperFormat {
  const beeperPMP: PerMessageProfileBeeperFormat = {
    id: profile.id,
    displayname: profile.displayname,
    avatar_url: profile.avatar_url,
    [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]:
      profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME],
    [MATRIX_UNSTABLE_COLORS]: profile[MATRIX_UNSTABLE_COLORS],
    has_fallback,
  };
  if (!profile.displayname || profile.displayname.trim().length === 0) delete beeperPMP.displayname;
  if (!profile.avatar_url) delete beeperPMP.avatar_url;
  if (
    !profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME] ||
    profile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]?.length === 0
  )
    delete beeperPMP[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME];
  if (!profile[MATRIX_UNSTABLE_COLORS]) delete beeperPMP[MATRIX_UNSTABLE_COLORS];
  if (!has_fallback) delete beeperPMP.has_fallback;
  return beeperPMP;
}

export function convertBeeperFormatToOurPerMessageProfile(
  beeperProfile: PerMessageProfileBeeperFormat
): Persona {
  return {
    id: beeperProfile.id,
    displayname: beeperProfile.displayname ?? '',
    avatar_url: beeperProfile.avatar_url,
    [MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME]:
      beeperProfile[MATRIX_UNSTABLE_PROFILE_PRONOUNS_PROPERTY_NAME],
    [MATRIX_UNSTABLE_COLORS]: beeperProfile[MATRIX_UNSTABLE_COLORS],
    trigger: { prefix: [] },
  };
}

/** Projects a stored persona to the fields that may be sent with a message. */
export function projectPersona(persona: Persona): PerMessageProfileBeeperFormat {
  return convertPerMessageProfileToBeeperFormat(persona, false);
}

export function stripPerMessageProfilePlainBody(formatted_body: string, profile?: Persona): string {
  if (profile) return formatted_body.replace(`${profile.displayname}: `, '');
  return formatted_body.replace(/^.*?: /, '');
}

export function stripPerMessageProfileFormattedBody(formatted_body: string): string {
  return formatted_body.replace(/^<strong\s+data-mx-profile-fallback[^>]*>.*?<\/strong>/, '');
}
