'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useSession } from '@/app/providers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function OrgSwitcher() {
  const { memberships, activeOrgId, setActiveOrgId } = useSession();
  const active = memberships.find((membership) => membership.org_id === activeOrgId);

  if (memberships.length === 0) {
    return <span className="text-sm text-muted-foreground">No organizations</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <span className="font-medium">{active?.organization.name ?? 'Select organization'}</span>
          {active ? (
            <Badge variant="secondary" className="font-normal">
              {active.role}
            </Badge>
          ) : null}
          <ChevronsUpDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Your role is per organization
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {memberships.map((membership) => (
          <DropdownMenuItem
            key={membership.id}
            onSelect={() => setActiveOrgId(membership.org_id)}
            className="gap-2"
          >
            <Check
              className={`size-3.5 ${membership.org_id === activeOrgId ? 'opacity-100' : 'opacity-0'}`}
            />
            <span className="flex-1">{membership.organization.name}</span>
            <Badge variant="outline" className="font-normal">
              {membership.role}
            </Badge>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
