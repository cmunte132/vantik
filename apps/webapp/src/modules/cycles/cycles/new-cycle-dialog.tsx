import { zodResolver } from '@hookform/resolvers/zod';
import { RiCalendarLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { Calendar } from '@vantikhq/ui/components/calendar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@vantikhq/ui/components/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@vantikhq/ui/components/form';
import { Input } from '@vantikhq/ui/components/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@vantikhq/ui/components/popover';
import { Textarea } from '@vantikhq/ui/components/textarea';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { format } from 'date-fns';
import { observer } from 'mobx-react-lite';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { CycleType } from 'common/types';

import { useCycles } from 'hooks/cycles';
import { useCurrentTeam } from 'hooks/teams';

import { useCreateCycleMutation } from 'services/cycle';

const NewCycleSchema = z
  .object({
    name: z.string().min(1, { message: 'Give the cycle a name' }),
    startDate: z.string().min(1, { message: 'Pick a start date' }),
    endDate: z.string().min(1, { message: 'Pick an end date' }),
    description: z.string().optional(),
  })
  .refine((values) => new Date(values.endDate) > new Date(values.startDate), {
    message: 'The cycle has to end after it starts',
    path: ['endDate'],
  });

interface NewCycleDialogProps {
  open: boolean;
  setOpen: (value: boolean) => void;
}

/** Two weeks from today — the length most teams pick, and easy to change. */
function defaultDates() {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 14);

  return { start: start.toISOString(), end: end.toISOString() };
}

export const NewCycleDialog = observer(
  ({ open, setOpen }: NewCycleDialogProps) => {
    const team = useCurrentTeam();
    const { cycles } = useCycles();
    const { toast } = useToast();

    // Numbered from what the team already has, matching what the server will
    // assign, so the name in the dialog is the name on the cycle.
    const nextNumber =
      cycles.reduce(
        (highest: number, cycle: CycleType) =>
          Math.max(highest, cycle.number ?? 0),
        0,
      ) + 1;

    const dates = React.useMemo(defaultDates, []);

    const form = useForm<z.infer<typeof NewCycleSchema>>({
      resolver: zodResolver(NewCycleSchema),
      defaultValues: {
        name: `Cycle ${nextNumber}`,
        startDate: dates.start,
        endDate: dates.end,
      },
    });

    React.useEffect(() => {
      if (open) {
        form.reset({
          name: `Cycle ${nextNumber}`,
          startDate: dates.start,
          endDate: dates.end,
          description: '',
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, nextNumber]);

    const { mutate: createCycle, isPending } = useCreateCycleMutation({
      // Deliberately not written into the cycles store here. That store keeps
      // `preferences` as a JSON *string* — the sync path stringifies it on the
      // way in — so handing it the raw API object throws, and the dialog would
      // stay open over a cycle that had in fact been created. The socket
      // delivers it correctly shaped a moment later.
      onSuccess: (cycle) => {
        setOpen(false);
        toast({
          variant: 'success',
          title: 'Cycle created',
          description: `${cycle.name} is ready to start`,
        });
      },
      onError: (error: string) => {
        toast({
          variant: 'destructive',
          title: 'Could not create the cycle',
          description: error,
        });
      },
    });

    const onSubmit = (values: z.infer<typeof NewCycleSchema>) => {
      createCycle({ teamId: team.id, ...values });
    };

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>New cycle</DialogTitle>
          </DialogHeader>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-3">
                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem className="grow">
                      <FormLabel>Starts</FormLabel>
                      <FormControl>
                        <CycleDatePicker
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="endDate"
                  render={({ field }) => (
                    <FormItem className="grow">
                      <FormLabel>Ends</FormLabel>
                      <FormControl>
                        <CycleDatePicker
                          value={field.value}
                          onChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder="What is this cycle for?"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="secondary" isLoading={isPending}>
                  Create cycle
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    );
  },
);

interface CycleDatePickerProps {
  value?: string;
  onChange: (value: string) => void;
}

function CycleDatePicker({ value, onChange }: CycleDatePickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          className="w-full justify-start gap-2 font-normal"
        >
          <RiCalendarLine size={16} />
          {value ? format(new Date(value), 'PP') : 'Pick a date'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          selected={value ? new Date(value) : undefined}
          onSelect={(date: Date) => date && onChange(date.toISOString())}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
