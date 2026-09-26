import { Allow } from 'class-validator';

export class UpdateActionInputsDto {
  // Whatever the action's own input schema says, which this side never sees.
  @Allow()
  inputs: any;
}
