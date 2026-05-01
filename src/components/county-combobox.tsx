import { useMemo, useState } from 'react'
import { ChevronsUpDownIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { Id } from '../../convex/_generated/dataModel'

export type CountyOption = {
  _id: Id<'counties'>
  name: string
  stateCode: string
}

export function CountyCombobox({
  counties,
  value,
  onChange,
  placeholder = 'Select county...',
  className,
  disabled,
}: {
  counties: ReadonlyArray<CountyOption>
  value: Id<'counties'> | ''
  onChange: (id: Id<'counties'>) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = useMemo(
    () => counties.find((c) => c._id === value),
    [counties, value]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          {selected
            ? `${selected.name} County, ${selected.stateCode}`
            : placeholder}
          <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) p-0"
        align="start"
      >
        <Command
          filter={(v, search) =>
            v.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search county..." />
          <CommandList>
            <CommandEmpty>No county found.</CommandEmpty>
            <CommandGroup>
              {counties.map((c) => {
                const label = `${c.name} County, ${c.stateCode}`
                return (
                  <CommandItem
                    key={c._id}
                    value={label}
                    data-checked={c._id === value}
                    onSelect={() => {
                      onChange(c._id)
                      setOpen(false)
                    }}
                  >
                    {label}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
