export type ShareChoice = 'public' | 'private';

export interface ShareParent {
  reshareable: boolean;
}

export function reshareable(
  parent: ShareParent | null | undefined,
  choice: ShareChoice
): boolean {
  if (!parent) {
    return false;
  }
  if (choice === 'private') {
    return false;
  }
  return parent.reshareable;
}

export function originalReshareable(choice: ShareChoice): boolean {
  return choice === 'public';
}
