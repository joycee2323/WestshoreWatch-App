// Role → capability map. Mirror of dashboard's src/lib/caps.js — keep in
// sync. Hide buttons rather than disable them; viewers shouldn't see
// destructive actions at all.
//
// Super admin (organizations.is_super_admin = true) bypasses every check
// here, matching the backend middleware short-circuit at auth.js:64.
//
// authStore.user is typed as `any` (no User interface defined upstream),
// so we accept the same and only read the two fields we need.

type CapsUser = {
  role?: 'super_admin' | 'org_admin' | 'operator' | 'viewer' | string | null;
  is_super_admin?: boolean;
} | null | undefined;

export type Caps = {
  canPairNode: boolean;
  canEditNode: boolean;
  canDeleteNode: boolean;
  canCreateDeployment: boolean;
  canPauseDeployment: boolean;
  canDeleteDeployment: boolean;
  canEditDrone: boolean;
  canExport: boolean;
  canViewBilling: boolean;
  canManageUsers: boolean;
  canDeleteOrg: boolean;
};

export function caps(user: CapsUser): Caps {
  const isSuper = !!user?.is_super_admin;
  const role = user?.role || 'viewer';
  const isAdmin = isSuper || role === 'org_admin';
  const isOperator = isAdmin || role === 'operator';
  return {
    canPairNode:         isOperator,
    canEditNode:         isOperator,
    canDeleteNode:       isAdmin,
    canCreateDeployment: isOperator,
    canPauseDeployment:  isAdmin,
    canDeleteDeployment: isAdmin,
    canEditDrone:        isOperator,
    canExport:           isOperator,
    canViewBilling:      isAdmin,
    canManageUsers:      isAdmin,
    canDeleteOrg:        isSuper,
  };
}
