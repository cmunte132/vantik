import { zodResolver } from '@hookform/resolvers/zod';
import { Product } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from '@vantikhq/ui/components/form';
import { Input } from '@vantikhq/ui/components/input';
import { useToast } from '@vantikhq/ui/components/use-toast';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useCreateProductMutation } from 'services/product-axis';

import { useContextStore } from 'store/global-context-provider';

import { SettingSection } from '../setting-section';

export const CreateNewProductSchema = z.object({
  name: z
    .string()
    .min(2, {
      message: 'Product name must be atleast 2 characters',
    })
    .max(50),
  description: z.string().max(200).optional(),
  key: z.string().max(20).optional(),
});

/**
 * The form that makes a product.
 *
 * A product starts here and not in a row at the top of the product list. It is
 * the same page as the form for a team, because a product and a team are the
 * two axes of this workspace. A person who made one must not have to learn a
 * second way to make the other.
 */
export const CreateNewProduct = observer(() => {
  const form = useForm<z.infer<typeof CreateNewProductSchema>>({
    resolver: zodResolver(CreateNewProductSchema),
    defaultValues: {
      name: '',
      description: '',
      key: '',
    },
  });
  const { toast } = useToast();
  const router = useRouter();
  const { workspaceSlug } = router.query;
  const { productsStore } = useContextStore();

  const [created, setCreated] = React.useState<Product | undefined>();
  const inStore = created
    ? Boolean(productsStore.getProductWithId(created.id))
    : false;

  /**
   * A made product is a product to look at, so this page hands the reader to
   * it.
   *
   * The socket brings the new row to the store a moment after the POST
   * answers, and the page of a product that the store does not hold says "No
   * product found". This waits for the row. If the message does not come, it
   * goes anyway after four seconds: the product exists on the server, and its
   * own page reports the state of it better than this form can.
   */
  React.useEffect(() => {
    if (!created) {
      return undefined;
    }

    const href = `/${workspaceSlug}/product/${created.key}`;

    if (inStore) {
      router.push(href);

      return undefined;
    }

    const timer = setTimeout(() => router.push(href), 4000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created, inStore]);

  const { mutate: createProduct } = useCreateProductMutation({
    onSuccess: (data: Product) => {
      toast({
        title: 'Created!',
        description: `New product ${data.name} is created`,
      });
      form.reset();
      setCreated(data);
    },
  });

  const onSubmit = ({
    name,
    description,
    key,
  }: z.infer<typeof CreateNewProductSchema>) => {
    // The server makes a key from the name, and it makes that key unique. An
    // empty field must therefore go as no field, and not as an empty string.
    createProduct({
      name,
      ...(description?.trim() ? { description: description.trim() } : {}),
      ...(key?.trim() ? { key: key.trim() } : {}),
    });
  };

  return (
    <SettingSection
      title="Create a new product"
      description="Create a new product to group the modules that build it"
    >
      <div className="max-w-[400px]">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Product name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Cloud" {...field} />
                  </FormControl>

                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormDescription>
                    What this product is, in a line. A product is what you ship
                    to customers. It holds no code of its own — the modules it
                    owns hold that.
                  </FormDescription>

                  <FormControl>
                    <Input
                      placeholder="e.g. The hosted service customers sign up for"
                      {...field}
                    />
                  </FormControl>

                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="key"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Product identifier</FormLabel>
                  <FormDescription>
                    This is used in the address of the product (e.g
                    /product/cloud). Leave it empty and we make one from the
                    name.
                  </FormDescription>

                  <FormControl>
                    <Input placeholder="e.g. cloud" {...field} />
                  </FormControl>

                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end items-center">
              <Button
                type="submit"
                variant="secondary"
                isLoading={form.formState.isSubmitting}
              >
                Create
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </SettingSection>
  );
});
